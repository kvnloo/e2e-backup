# @e2e-dev/util

Native utilities for [e2e](https://github.com/e2e-inc/e2e): work that would
block the JavaScript thread, done in Rust and run on a native worker pool.
The first job is image processing: PNG decoding and encoding, box
resampling, cropping, masking, and screenshot comparison (a bit-exact port
of pixelmatch 8).

e2e depends on this package. You do not need to install it yourself.

## How it works

- The logic is the `e2e-util` crate (`crates/e2e-util`), plain Rust with no
  binding dependency. The Node addon is `crates/e2e-util-napi`, built with
  NAPI-RS.
- Every call that touches pixels returns a Promise. The work runs on a
  blocking thread of NAPI-RS's tokio runtime, at most one call per core.
- A decoded image stays on the native side as a `NativeImage`. V8 is told
  how much memory it holds, so many images in a row press the garbage
  collector as their memory does.
- The addon loads on the first call, not on import. A checkout build
  (`util.<platform>.node` in this directory) is tried first, then the
  platform package `@e2e-dev/util-<platform>`.

## Development

```bash
pnpm --filter @e2e-dev/util build:native   # cargo build --release, places util.<platform>.node here
pnpm --filter @e2e-dev/util build          # the TypeScript
pnpm --filter @e2e-dev/util test           # the addon against the JavaScript it replaced, byte for byte
pnpm --filter @e2e-dev/util bench          # the addon against that JavaScript: time, event-loop stalls, memory
cargo test -p e2e-util                     # the crate alone
```

The tests and the benchmark render browser screenshots with Chromium on
first use and keep them in `.cache/`.

## License

Apache-2.0
