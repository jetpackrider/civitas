# Offline Alpine fixture

`block-v1/` is an explicitly marked test dataset derived from the completed Alpine county build. Source URLs and checksums are recorded in its manifest. It preserves the real precinct/block-group geometry, all 202 original block count rows and two audited presidential contests (2020/2024). `source-counts.json` separately snapshots the official block counts and original legacy parent IDs used as validation truth.

Use `npm run test:fixture:refresh` to deliberately regenerate it, then review and commit the diff. Normal setup and tests never regenerate it. It is copied only into temporary test web directories and cannot pass release validation.
