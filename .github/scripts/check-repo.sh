#!/usr/bin/env bash
# Repository checks that need no toolchain: run by CI and usable before a push.
#
#   bash .github/scripts/check-repo.sh
#
# 1. Nothing that looks like a live secret is committed.
# 2. User-facing text calls the browser Phantom. "chromium" is allowed only
#    where a developer types it (Playwright's `chromium.connect_over_cdp`,
#    `import { chromium }`): code blocks and code spans are not checked.
# 3. The files a public repository should have are there.
set -euo pipefail
cd "$(dirname "$0")/../.."
fail=0

if grep -rInE 'agt_live_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|AIza[0-9A-Za-z_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY' \
     --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude=check-repo.sh .; then
  echo "::error title=Secret::Something above looks like a secret."
  fail=1
fi

# Prose only: Markdown outside code fences and code spans.
while IFS= read -r -d '' f; do
  awk -v file="$f" '
    /^[[:space:]]*(```|~~~)/ { fence = !fence; next }
    fence { next }
    {
      line = $0
      gsub(/`[^`]*`/, "", line)
      if (tolower(line) ~ /chromium/) { printf "%s:%d: %s\n", file, NR, $0; found = 1 }
    }
    END { exit found ? 1 : 0 }
  ' "$f" || { echo "::error file=$f,title=Browser name::Call the browser Phantom in prose (see the lines above)."; fail=1; }
done < <(find . -name '*.md' -not -path './.git/*' -not -path '*/node_modules/*' -print0)

for f in README.md LICENSE CHANGELOG.md SECURITY.md CONTRIBUTING.md CODE_OF_CONDUCT.md \
         .github/PULL_REQUEST_TEMPLATE.md .github/ISSUE_TEMPLATE/bug_report.yml .github/ISSUE_TEMPLATE/config.yml \
         .github/workflows/ci.yml .github/workflows/release.yml examples/README.md; do
  [ -f "$f" ] || { echo "::error title=Missing file::$f is missing"; fail=1; }
done

[ "$fail" = 0 ] && echo "Repository checks passed."
exit "$fail"
