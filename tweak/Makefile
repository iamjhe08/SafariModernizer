# SM_IOS=14 builds the iOS 14 variant (iOS 14.0 and newer)
ifeq ($(SM_IOS),14)
TARGET := iphone:clang:14.5:14.0
else
TARGET := iphone:clang:14.5:15.0
endif
ARCHS = arm64 arm64e
INSTALL_TARGET_PROCESSES = MobileSafari SafariViewService

include $(THEOS)/makefiles/common.mk

TWEAK_NAME = SafariModernizer
SafariModernizer_FILES = Tweak.x
SafariModernizer_CFLAGS = -fobjc-arc
SafariModernizer_FRAMEWORKS = Foundation UIKit WebKit

include $(THEOS_MAKE_PATH)/tweak.mk
