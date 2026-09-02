#!/bin/bash
cd agents

update_model() {
  local file=$1
  local new_model=$2
  sed -i "s|model: opencode/x-preview-f-free|model: $new_model|g" "$file"
}

# Ultra (Pro tier)
update_model lead-dev.md "opencode/nemotron-3-ultra-free"
update_model frontend-specialist.md "opencode/nemotron-3-ultra-free"
update_model backend-specialist.md "opencode/nemotron-3-ultra-free"
update_model db-specialist.md "opencode/nemotron-3-ultra-free"
update_model devops-specialist.md "opencode/nemotron-3-ultra-free"
update_model security-auditor.md "opencode/nemotron-3-ultra-free"
update_model animation-specialist.md "opencode/nemotron-3-ultra-free"

# Mimo (Proofreader)
update_model code-proofreader.md "opencode/mimo-v2.5-free"

# Muse Spark (Creative/Content)
update_model seo-specialist.md "opencode/muse-spark-1.2-contributor-free"
update_model linkedin-specialist.md "opencode/muse-spark-1.2-contributor-free"

# Lightning (Flash tier / all others)
for file in *.md; do
  # If it still has x-preview-f-free, it hasn't been updated yet
  sed -i "s|model: opencode/x-preview-f-free|model: opencode/nemotron-3.5-lightning-free|g" "$file"
done

echo "Update complete"
