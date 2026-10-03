// SafariModernizer by T4MAG0 (MIT License)
// Makes newer websites work in Safari on iOS 15.x:
//  1. Injects polyfills for missing JavaScript and web features
//     (including the Popover API and runtime lookbehind regexes).
//  2. Rewrites modern CSS (@layer, nesting, range media queries, oklch
//     colors) into CSS that Safari 15.1 understands.
//  3. Runs ES modules that need import maps (Safari 16.4) through a small
//     loader, executing them via WKWebView so the page's CSP doesn't block it.
//  4. Identifies as Safari 18.6 so sites send their modern pages.
//  5. Adds a log panel: hold two fingers on a page for 2 seconds, or add
//     #smdebug to the address, to see errors and per-site settings.

#import <WebKit/WebKit.h>
#import <CommonCrypto/CommonDigest.h>
#import <objc/runtime.h>
#import <UIKit/UIKit.h>
#include "polyfill.h"
#include "smfix.h"

static const void *kSMInstalledKey = &kSMInstalledKey;
static const void *kSMRealUAKey = &kSMRealUAKey;   // this tab currently sends Safari's real ID
static NSString *const kSMHandlerName = @"__smcss";
static const NSUInteger kSMMaxBytes = 12 * 1024 * 1024;

// Sites like Google send a stripped-down page to old Safari versions based
// on the browser's ID string. With the fixes above in place, identify as
// Safari 18.6 on iPhone so they send their normal modern pages.
static NSString *const kSMUserAgent =
    @"Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";

#pragma mark - Fetch, cache, eval bridge

// Page-side helper calls this handler to:
//   get  {kind, url}   -> {data} (cached rewrite) or {raw} (file text)
//   put  {kind, url, data}
//   eval {code}        -> runs code in the page's own JS world for that frame
// "eval" lets the module loader run rewritten module code on sites whose
// Content Security Policy blocks eval/blob scripts. It only runs code in the
// same page and frame that asked, which that page could already run itself.
@interface SMCSSHandler : NSObject <WKScriptMessageHandlerWithReply>
@property (nonatomic, strong) NSCache<NSString *, NSString *> *cache;
@property (nonatomic, strong) NSMapTable<WKWebView *, NSMutableDictionary *> *pages;  // freeze watchdog state per tab
@property (nonatomic, strong) NSMutableDictionary *settings;                        // {safe:{host:n}, reasons:{host:stage}, events:[...]}
@property (nonatomic, copy) NSString *settingsPath;
@property (nonatomic, strong) NSTimer *watchdog;
@property (nonatomic, strong) NSURLSession *session;
@property (nonatomic, copy) NSString *diskDir;
+ (instancetype)shared;
@end

@implementation SMCSSHandler

+ (instancetype)shared {
    static SMCSSHandler *h;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ h = [SMCSSHandler new]; });
    return h;
}

- (instancetype)init {
    if ((self = [super init])) {
        _cache = [NSCache new];
        _cache.totalCostLimit = 80 * 1024 * 1024;
        NSURLSessionConfiguration *cfg = [NSURLSessionConfiguration ephemeralSessionConfiguration];
        cfg.HTTPShouldSetCookies = NO;
        cfg.HTTPCookieAcceptPolicy = NSHTTPCookieAcceptPolicyNever;
        cfg.timeoutIntervalForRequest = 25;
        cfg.HTTPMaximumConnectionsPerHost = 8;
        cfg.URLCache = [[NSURLCache alloc] initWithMemoryCapacity:30 * 1024 * 1024 diskCapacity:0 diskPath:nil];
        _session = [NSURLSession sessionWithConfiguration:cfg];
        NSString *caches = NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES).firstObject;
        if (caches) {
            // Rewrites saved by older versions are not reused: bump kSMCacheVer
            // whenever the CSS/JS rewriter changes its output.
            static const int kSMCacheVer = 8;
            for (int v = 1; v < kSMCacheVer; v++)
                [[NSFileManager defaultManager] removeItemAtPath:[caches stringByAppendingPathComponent:[NSString stringWithFormat:@"SafariModernizer-v%d", v]] error:nil];
            _diskDir = [caches stringByAppendingPathComponent:[NSString stringWithFormat:@"SafariModernizer-v%d", kSMCacheVer]];
            [[NSFileManager defaultManager] createDirectoryAtPath:_diskDir withIntermediateDirectories:YES attributes:nil error:nil];
            _settingsPath = [caches stringByAppendingPathComponent:@"SafariModernizer-settings.plist"];
        }
        NSDictionary *saved = _settingsPath ? [NSDictionary dictionaryWithContentsOfFile:_settingsPath] : nil;
        // Settings v2: modes set automatically by 1.8.0 were often wrong
        // (it lowered sites for freezes in the site's own code), so start fresh.
        if ([saved[@"ver"] integerValue] != 2) saved = nil;
        _settings = [NSMutableDictionary dictionary];
        _settings[@"safe"] = [NSMutableDictionary dictionaryWithDictionary:saved[@"safe"] ?: @{}];
        _settings[@"reasons"] = [NSMutableDictionary dictionaryWithDictionary:saved[@"reasons"] ?: @{}];
        _settings[@"events"] = [NSMutableArray arrayWithArray:saved[@"events"] ?: @[]];
        _settings[@"realUA"] = [NSMutableDictionary dictionaryWithDictionary:saved[@"realUA"] ?: @{}];
        _settings[@"ver"] = @2;
        _pages = [NSMapTable weakToStrongObjectsMapTable];
        __weak SMCSSHandler *weakSelf = self;
        _watchdog = [NSTimer scheduledTimerWithTimeInterval:3 repeats:YES block:^(NSTimer *t) { [weakSelf checkFrozen]; }];
        // Coming back to Safari: page timers were paused, so don't count that as a freeze
        [[NSNotificationCenter defaultCenter] addObserverForName:UIApplicationDidBecomeActiveNotification object:nil queue:nil
                                                      usingBlock:^(NSNotification *n) { [weakSelf resetBeats]; }];
    }
    return self;
}

static BOOL SMIsWebURL(NSURL *u) {
    NSString *s = u.scheme.lowercaseString;
    return u.host.length && ([s isEqualToString:@"https"] || [s isEqualToString:@"http"]);
}

// Files whose name has a long hex/base hash never change, so their rewrite
// can be kept on disk across launches.
static BOOL SMLooksImmutable(NSURL *u) {
    NSString *s = [u.lastPathComponent stringByAppendingString:(u.query ?: @"")];
    NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:@"[0-9a-fA-F]{8,}|[A-Za-z0-9_-]{20,}" options:0 error:nil];
    return [re numberOfMatchesInString:s options:0 range:NSMakeRange(0, s.length)] > 0;
}

- (NSString *)diskPathForKey:(NSString *)key {
    if (!self.diskDir) return nil;
    NSData *d = [key dataUsingEncoding:NSUTF8StringEncoding];
    unsigned char md[CC_SHA1_DIGEST_LENGTH];
    CC_SHA1(d.bytes, (CC_LONG)d.length, md);
    NSMutableString *hex = [NSMutableString string];
    for (int i = 0; i < CC_SHA1_DIGEST_LENGTH; i++) [hex appendFormat:@"%02x", md[i]];
    return [self.diskDir stringByAppendingPathComponent:hex];
}

- (NSString *)cachedForKey:(NSString *)key url:(NSURL *)url {
    NSString *v = [self.cache objectForKey:key];
    if (v) return v;
    if (!SMLooksImmutable(url)) return nil;
    NSString *path = [self diskPathForKey:key];
    v = path ? [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:nil] : nil;
    if (v) [self.cache setObject:v forKey:key cost:v.length + 1];
    return v;
}

- (void)store:(NSString *)value key:(NSString *)key url:(NSURL *)url {
    [self.cache setObject:value forKey:key cost:value.length + 1];
    if (!SMLooksImmutable(url)) return;
    NSString *path = [self diskPathForKey:key];
    if (!path) return;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        [value writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil];
    });
}

#pragma mark Freeze watchdog

- (void)saveSettings {
    if (self.settingsPath) [self.settings writeToFile:self.settingsPath atomically:YES];
}

- (void)resetBeats {
    NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];
    for (WKWebView *wv in self.pages.keyEnumerator) [self.pages objectForKey:wv][@"last"] = @(now);
}

// A visible page whose heartbeat stopped for 12 s is frozen. Record what was
// running. Only when one of the tweak's own steps was running does the site
// get a lighter mode next time; a freeze inside the site's own scripts is
// just recorded, since turning tweak features off won't help it.
static BOOL SMIsSiteScript(NSString *stage) {
    return [stage hasPrefix:@"script "] || [stage hasPrefix:@"inline script"];
}

- (void)checkFrozen {
    NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];
    for (WKWebView *wv in self.pages.keyEnumerator) {
        NSMutableDictionary *p = [self.pages objectForKey:wv];
        if ([p[@"bye"] boolValue] || ![p[@"visible"] boolValue] || [p[@"reported"] boolValue]) continue;
        if (now - [p[@"last"] doubleValue] < 12) continue;
        NSString *host = p[@"host"];
        if (!host.length) continue;
        p[@"reported"] = @YES;

        NSArray *stages = p[@"stages"] ?: @[];
        BOOL tweakStep = NO;
        for (NSString *st in stages) if (!SMIsSiteScript(st)) tweakStep = YES;
        NSMutableArray *show = [NSMutableArray array];
        for (NSInteger i = (NSInteger)stages.count - 1; i >= 0 && show.count < 3; i--) [show addObject:stages[i]];
        NSString *stage = show.count ? [show componentsJoinedByString:@" + "] : @"the site's own code (no script or tweak step open)";
        if (stages.count > 3) stage = [stage stringByAppendingFormat:@" (+%lu more)", (unsigned long)(stages.count - 3)];
        NSString *lastDone = @"";
        if (p[@"lastDone"]) lastDone = [NSString stringWithFormat:@"%@, %.0f s before the page stopped", p[@"lastDone"], MAX(0, [p[@"last"] doubleValue] - [p[@"lastDoneAt"] doubleValue])];

        NSMutableDictionary *safe = self.settings[@"safe"];
        NSInteger level = [safe[host] integerValue];
        if (tweakStep && level < 3) {
            level += 1;
            safe[host] = @(level);
            self.settings[@"reasons"][host] = stage;
        }
        NSMutableArray *events = self.settings[@"events"];
        [events addObject:@{ @"host": host, @"stage": stage, @"lastDone": lastDone, @"level": @(level),
                             @"escalated": @(tweakStep), @"time": @(now) }];
        while (events.count > 20) [events removeObjectAtIndex:0];
        [self saveSettings];
    }
}

- (NSMutableDictionary *)pageFor:(WKWebView *)wv {
    if (!wv) return nil;
    NSMutableDictionary *p = [self.pages objectForKey:wv];
    if (!p) { p = [NSMutableDictionary dictionary]; [self.pages setObject:p forKey:wv]; }
    return p;
}

- (void)userContentController:(WKUserContentController *)ucc
      didReceiveScriptMessage:(WKScriptMessage *)message
                 replyHandler:(void (^)(id reply, NSString *error))replyHandler {
    NSDictionary *body = [message.body isKindOfClass:[NSDictionary class]] ? message.body : nil;
    NSString *op = [body[@"op"] isKindOfClass:[NSString class]] ? body[@"op"] : nil;

    NSString *h = [body[@"host"] isKindOfClass:[NSString class]] ? body[@"host"] : nil;
    if ([op isEqualToString:@"beat"]) {
        NSMutableDictionary *p = [self pageFor:message.webView];
        if (message.frameInfo.isMainFrame && p) {
            if (h && ![h isEqualToString:p[@"host"]]) { [p removeObjectForKey:@"stages"]; [p removeObjectForKey:@"lastDone"]; p[@"reported"] = @NO; }
            p[@"host"] = h ?: @"";
            p[@"last"] = @([NSDate timeIntervalSinceReferenceDate]);
            p[@"visible"] = @([body[@"visible"] boolValue]);
            p[@"bye"] = @NO;
            if ([p[@"reported"] boolValue]) p[@"reported"] = @NO;
        }
        replyHandler(@YES, nil);
        return;
    }
    if ([op isEqualToString:@"stage"]) {
        NSMutableDictionary *p = [self pageFor:message.webView];
        NSString *name = [body[@"name"] isKindOfClass:[NSString class]] ? body[@"name"] : @"?";
        NSMutableArray *stages = p[@"stages"];
        if (!stages) { stages = [NSMutableArray array]; p[@"stages"] = stages; }
        if ([body[@"phase"] isEqualToString:@"start"]) {
            [stages addObject:name];
            while (stages.count > 200) [stages removeObjectAtIndex:0];
        } else {
            NSUInteger i = [stages indexOfObjectWithOptions:NSEnumerationReverse passingTest:^BOOL(id o, NSUInteger idx, BOOL *stop) { return [o isEqualToString:name]; }];
            if (i != NSNotFound) [stages removeObjectAtIndex:i];
            p[@"lastDone"] = name;
            p[@"lastDoneAt"] = @([NSDate timeIntervalSinceReferenceDate]);
        }
        replyHandler(@YES, nil);
        return;
    }
    if ([op isEqualToString:@"bye"]) {
        if (message.frameInfo.isMainFrame) [self pageFor:message.webView][@"bye"] = @YES;
        replyHandler(@YES, nil);
        return;
    }
    if ([op isEqualToString:@"cfg"]) {
        NSNumber *lvl = h ? self.settings[@"safe"][h] : nil;
        NSString *why = h ? self.settings[@"reasons"][h] : nil;
        // Per-site browser ID: switch this tab's ID if it doesn't match the
        // site's setting, then ask the page to reload once with the right one.
        BOOL wantReal = h ? [self.settings[@"realUA"][h] boolValue] : NO;
        BOOL reload = NO;
        WKWebView *wv = message.webView;
        if (wv && message.frameInfo.isMainFrame) {
            BOOL isReal = [objc_getAssociatedObject(wv, kSMRealUAKey) boolValue];
            if (wantReal != isReal) {
                objc_setAssociatedObject(wv, kSMRealUAKey, @(wantReal), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
                wv.customUserAgent = wantReal ? @"" : kSMUserAgent;
                reload = YES;
            }
        }
        replyHandler(@{ @"safe": lvl ?: @0, @"reason": why ?: @"", @"realUA": @(wantReal), @"reload": @(reload) }, nil);
        return;
    }
    if ([op isEqualToString:@"setua"]) {
        if (h.length) {
            if ([body[@"real"] boolValue]) self.settings[@"realUA"][h] = @YES;
            else [self.settings[@"realUA"] removeObjectForKey:h];
            [self saveSettings];
        }
        replyHandler(@YES, nil);
        return;
    }
    if ([op isEqualToString:@"setsafe"]) {
        NSInteger lvl = MAX(0, MIN(4, [body[@"level"] integerValue]));
        if (h.length) {
            if (lvl == 0) { [self.settings[@"safe"] removeObjectForKey:h]; [self.settings[@"reasons"] removeObjectForKey:h]; }
            else { self.settings[@"safe"][h] = @(lvl); self.settings[@"reasons"][h] = @"set by hand"; }
            [self saveSettings];
        }
        replyHandler(@YES, nil);
        return;
    }
    if ([op isEqualToString:@"log"]) {
        NSString *msg = [body[@"msg"] isKindOfClass:[NSString class]] ? body[@"msg"] : @"";
        NSLog(@"[SafariModernizer] %@ %@: %@", [NSBundle mainBundle].bundleIdentifier, h ?: @"", msg);
        replyHandler(@YES, nil);
        return;
    }
    if ([op isEqualToString:@"events"]) {
        replyHandler(self.settings[@"events"] ?: @[], nil);
        return;
    }

    if ([op isEqualToString:@"eval"]) {
        NSString *code = [body[@"code"] isKindOfClass:[NSString class]] ? body[@"code"] : nil;
        WKWebView *wv = message.webView;
        if (!code || !wv) { replyHandler(nil, @"bad eval"); return; }
        void (^reply)(id, NSString *) = [replyHandler copy];
        [wv evaluateJavaScript:code inFrame:message.frameInfo inContentWorld:WKContentWorld.pageWorld
             completionHandler:^(id result, NSError *error) {
            if (error) reply(nil, error.localizedDescription ?: @"eval failed");
            else reply(@YES, nil);
        }];
        return;
    }

    NSString *kind = [body[@"kind"] isKindOfClass:[NSString class]] ? body[@"kind"] : @"css";
    NSString *urlString = [body[@"url"] isKindOfClass:[NSString class]] ? body[@"url"] : nil;
    NSURL *url = urlString ? [NSURL URLWithString:urlString] : nil;
    if (!op || !url || !SMIsWebURL(url)) { replyHandler(nil, @"bad request"); return; }
    NSString *key = [kind stringByAppendingFormat:@":%@", urlString];

    if ([op isEqualToString:@"put"]) {
        NSString *data = [body[@"data"] isKindOfClass:[NSString class]] ? body[@"data"] : nil;
        if (data && data.length < kSMMaxBytes * 2) [self store:data key:key url:url];
        replyHandler(@YES, nil);
        return;
    }

    if (![op isEqualToString:@"get"]) { replyHandler(nil, @"bad op"); return; }

    NSString *cached = [self cachedForKey:key url:url];
    if (cached) { replyHandler(@{ @"data": cached }, nil); return; }

    BOOL wantJS = [kind isEqualToString:@"js"] || [kind isEqualToString:@"jsraw"] || [kind isEqualToString:@"cjs"];
    NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:url];
    [req setValue:(wantJS ? @"*/*" : @"text/css,*/*;q=0.1") forHTTPHeaderField:@"Accept"];
    WKSecurityOrigin *so = message.frameInfo.securityOrigin;
    if (so.host.length) {
        NSString *origin = [NSString stringWithFormat:@"%@://%@", so.protocol ?: @"https", so.host];
        if (so.port) origin = [origin stringByAppendingFormat:@":%ld", (long)so.port];
        [req setValue:[origin stringByAppendingString:@"/"] forHTTPHeaderField:@"Referer"];
        [req setValue:origin forHTTPHeaderField:@"Origin"];
    }

    void (^reply)(id, NSString *) = [replyHandler copy];
    [[self.session dataTaskWithRequest:req completionHandler:^(NSData *data, NSURLResponse *resp, NSError *err) {
        NSString *text = nil;
        NSHTTPURLResponse *http = [resp isKindOfClass:[NSHTTPURLResponse class]] ? (NSHTTPURLResponse *)resp : nil;
        NSString *mime = resp.MIMEType.lowercaseString ?: @"";
        NSString *path = url.path.lowercaseString;
        BOOL typeOK = wantJS
            ? ([mime containsString:@"javascript"] || [mime containsString:@"ecmascript"] || [path hasSuffix:@".js"] || [path hasSuffix:@".mjs"])
            : ([mime containsString:@"css"] || [path hasSuffix:@".css"]);
        BOOL ok = !err && data && data.length < kSMMaxBytes &&
                  (!http || (http.statusCode >= 200 && http.statusCode < 300)) && typeOK;
        if (ok) {
            text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
            if (!text) text = [[NSString alloc] initWithData:data encoding:NSISOLatin1StringEncoding];
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            if (text) reply(@{ @"raw": text }, nil);
            else reply(nil, @"fetch failed");
        });
    }] resume];
}

@end

#pragma mark - Injection

static NSString *SMString(const unsigned char *bytes, unsigned int len) {
    return [[NSString alloc] initWithBytes:bytes length:len encoding:NSUTF8StringEncoding];
}

static NSArray<WKUserScript *> *SMScripts(void) {
    static NSString *poly, *fix;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        poly = SMString(polyfill_js, polyfill_js_len);
        fix = SMString(smfix_js, smfix_js_len);
    });
    // Runs before any page script, in every frame, in the page's own world.
    // Polyfills first: the CSS fixer and module loader rely on some of them.
    return @[
        [[WKUserScript alloc] initWithSource:poly injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:NO],
        [[WKUserScript alloc] initWithSource:fix injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:NO],
    ];
}

static void SMAddScripts(WKUserContentController *ucc) {
    for (WKUserScript *s in SMScripts()) [ucc addUserScript:s];
}

static void SMAddHandler(WKUserContentController *ucc) {
    @try {
        [ucc addScriptMessageHandlerWithReply:[SMCSSHandler shared]
                                 contentWorld:WKContentWorld.pageWorld
                                         name:kSMHandlerName];
    } @catch (NSException *e) {
        // already registered
    }
}

static void SMInstall(WKUserContentController *ucc) {
    if (!ucc || objc_getAssociatedObject(ucc, kSMInstalledKey)) return;
    objc_setAssociatedObject(ucc, kSMInstalledKey, @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    SMAddScripts(ucc);
    SMAddHandler(ucc);
}

%hook WKWebView

- (instancetype)initWithFrame:(CGRect)frame configuration:(WKWebViewConfiguration *)configuration {
    if (configuration) SMInstall(configuration.userContentController);
    WKWebView *wv = %orig;
    if (wv && !wv.customUserAgent.length) wv.customUserAgent = kSMUserAgent;
    return wv;
}

// If Safari clears the custom ID string, put the modern one back.
- (void)setCustomUserAgent:(NSString *)ua {
    // Empty means "Safari's default": keep it only on a site set to the real ID
    BOOL keepReal = !ua.length && [objc_getAssociatedObject(self, kSMRealUAKey) boolValue];
    NSString *value = (ua.length || keepReal) ? ua : kSMUserAgent;
    %orig(value);
}

%end

%hook WKUserContentController

// Safari sometimes clears user scripts or handlers (for example when content
// blockers reload). Put ours back so the fixes keep working.
- (void)removeAllUserScripts {
    %orig;
    if (objc_getAssociatedObject(self, kSMInstalledKey)) SMAddScripts(self);
}

- (void)removeAllScriptMessageHandlers {
    %orig;
    if (objc_getAssociatedObject(self, kSMInstalledKey)) SMAddHandler(self);
}

%end

#pragma mark - Which apps

// Loaded only into the browser apps listed in SafariModernizer.plist. Not
// every app that uses WebKit: that also loads it into WebKit's own helper
// processes, which broke Safari.
%ctor {
    @autoreleasepool {
        NSLog(@"[SafariModernizer] on in %@", [NSBundle mainBundle].bundleIdentifier ?: @"?");
        %init;
    }
}
