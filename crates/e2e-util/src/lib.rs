//! Work e2e moves off the JavaScript thread, in plain Rust: no binding crate is a dependency, so the Node addon
//! (`e2e-util-napi`) and any later binding for another language share one implementation, and `cargo test` alone
//! checks it.
//!
//! Every function that replaces JavaScript returns the bytes that JavaScript returned. The tests in
//! `packages/util/tests` run both on the same inputs and compare.

pub mod image;
