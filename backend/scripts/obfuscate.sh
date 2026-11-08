#!/bin/sh
set -e

echo "=================================================="
echo "    PyArmor Protection (Free License Mode)        "
echo "=================================================="

mkdir -p /build/protected
rm -rf /build/dist

# 1. Detect any files exceeding PyArmor free license 32KB cap
EXCLUDES=$(python -c "
import os
excludes = []
for root, dirs, files in os.walk('app'):
    for f in files:
        if f.endswith('.py'):
            p = os.path.join(root, f).replace('\\\\', '/')
            if os.path.getsize(p) >= 32000:
                excludes.append(p)
print(' '.join(f'--exclude \"{p}\"' for p in excludes))
")

LARGE_FILES=$(python -c "
import os
large = []
for root, dirs, files in os.walk('app'):
    for f in files:
        if f.endswith('.py'):
            p = os.path.join(root, f).replace('\\\\', '/')
            if os.path.getsize(p) >= 32000:
                large.append(p)
print(' '.join(large))
")

if [ -n "$LARGE_FILES" ]; then
    echo ">> Note: PyArmor Free License limits single-script size to 32KB."
    echo ">> The following files (>32KB) will be compiled to bytecode (.pyc) without source:"
    for lf in $LARGE_FILES; do
        echo "   - $lf"
    done
fi

# 2. Run PyArmor obfuscation with free trial license
echo ">> Obfuscating application package with PyArmor Free License..."
eval "pyarmor gen -O /build/dist -r $EXCLUDES app"

# 3. Stage protected app and PyArmor C-extension runtime
cp -r /build/dist/app /build/protected/app
cp -r /build/dist/pyarmor_runtime_* /build/protected/ 2>/dev/null || true

# 4. Compile any >32KB files to optimized bytecode (.pyc) and remove source
for lf in $LARGE_FILES; do
    echo ">> Compiling $lf to standalone bytecode (.pyc)..."
    python -c "
import py_compile, os
src = '$lf'
dest = os.path.join('/build/protected', src + 'c')
os.makedirs(os.path.dirname(dest), exist_ok=True)
py_compile.compile(src, cfile=dest, optimize=1)
print(f'   Protected: {dest}')
"
done

echo ">> [SUCCESS] Entire codebase protected without plaintext source code using PyArmor Free License!"
echo "=================================================="
