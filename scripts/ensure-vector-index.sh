#!/usr/bin/env bash
# Ensure a Vectorize index exists (with the "type" metadata index) before a
# Worker deploy that binds it. If it cannot be created (token without
# "Vectorize: Edit"), remove its binding from wrangler.toml so the deploy
# still succeeds without it.
#
#   scripts/ensure-vector-index.sh <index-name> <dimensions> <binding>
set -uo pipefail
INDEX="$1"; DIMS="$2"; BINDING="$3"
cd "$(dirname "$0")/../apps/worker"
if npx wrangler vectorize get "$INDEX" >/dev/null 2>&1; then
  echo "Vectorize index $INDEX exists."
  npx wrangler vectorize create-metadata-index "$INDEX" --propertyName=type --type=string >/dev/null 2>&1 || true
elif npx wrangler vectorize create "$INDEX" --dimensions="$DIMS" --metric=cosine \
     && npx wrangler vectorize create-metadata-index "$INDEX" --propertyName=type --type=string; then
  echo "Created Vectorize index $INDEX ($DIMS dimensions)."
else
  echo "::warning::Vectorize dizini $INDEX oluşturulamadı; Worker $BINDING bağlantısı olmadan dağıtılıyor."
  BINDING="$BINDING" python3 - <<'PY'
import os, pathlib, re
path = pathlib.Path("wrangler.toml")
text = path.read_text(encoding="utf-8")
binding = os.environ["BINDING"]
text = re.sub(r'\n(?:#[^\n]*\n)*\[\[vectorize\]\]\nbinding = "' + re.escape(binding) + r'"\nindex_name = "[^"]*"\n', "\n", text)
path.write_text(text, encoding="utf-8")
PY
fi
