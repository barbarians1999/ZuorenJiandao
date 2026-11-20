set -euo pipefail
export LC_ALL=C
expected="$PWD/.github/verified-0.3.3-assets.json"
cd release-files
test ! -e SHA256SUMS.txt
sha256sum -- * > "$RUNNER_TEMP/SHA256SUMS.txt"
cp "$RUNNER_TEMP/SHA256SUMS.txt" .
diff <(jq -r 'keys[]' "$expected" | sort) <(find . -maxdepth 1 -type f -printf '%f\n' | sort)
for file in *; do
  digest="$(sha256sum -- "$file" | cut -d ' ' -f1)"
  size="$(stat -c %s -- "$file")"
  jq -e --arg f "$file" --arg sha "$digest" --argjson size "$size" \
    '.[$f] == {size: $size, sha256: $sha}' "$expected" >/dev/null
done

read_draft() {
  gh release view "$TAG_NAME" --repo "$GITHUB_REPOSITORY" --json databaseId,isDraft,tagName,assets
}

verify_draft() {
  jq -e --slurpfile expected "$expected" '
    .databaseId == 453057448 and .isDraft and .tagName == "v0.3.3"
    and all(.assets[]; . as $asset |
      $expected[0][$asset.name] as $file |
      $file != null and $asset.size == $file.size and $asset.digest == ("sha256:" + $file.sha256))
  ' >/dev/null
}

release_json="$(read_draft)"
verify_draft <<< "$release_json"
missing=()
for file in *; do
  if ! jq -e --arg f "$file" 'any(.assets[]; .name == $f)' <<< "$release_json" >/dev/null; then
    missing+=("$file")
  fi
done
if ((${#missing[@]} > 0)); then
  gh release upload "$TAG_NAME" "${missing[@]}" --repo "$GITHUB_REPOSITORY"
fi
release_json="$(read_draft)"
verify_draft <<< "$release_json"
test "$(jq '.assets | length' <<< "$release_json")" = "$(jq 'length' "$expected")"
jq -r '.assets[] | [.name, .digest, .size] | @tsv' <<< "$release_json"
