#!/usr/bin/env python3
# Turns a .js file into a C header so the script ships inside the dylib.
# usage: embed.py input.js output.h varname
import sys
src, out, name = sys.argv[1], sys.argv[2], sys.argv[3]
data = open(src, 'rb').read()
with open(out, 'w') as f:
    f.write('// Generated from %s. Do not edit.\n' % src.split('/')[-1])
    f.write('static const unsigned char %s[] = {\n' % name)
    for i in range(0, len(data), 24):
        f.write('  ' + ','.join(str(b) for b in data[i:i + 24]) + ',\n')
    f.write('};\n')
    f.write('static const unsigned int %s_len = %d;\n' % (name, len(data)))
