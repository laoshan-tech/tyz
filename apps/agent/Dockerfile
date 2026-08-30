# Build context: repository root
#
# Multi-stage cross-compile: the builder runs natively on the build host
# (BUILDPLATFORM) and cross-compiles for TARGETARCH (no QEMU emulation —
# cargo under emulation takes tens of minutes), so aarch64 builds stay as
# fast as amd64. The toolchain is pinned by apps/agent/rust-toolchain.toml
# (nightly — kaminari needs unstable features); rustup auto-installs it on
# the first cargo call made inside apps/agent.

FROM --platform=$BUILDPLATFORM rust:1-bookworm AS build

WORKDIR /src
ARG TARGETARCH
# Agent version stamped into the binary (TYZ_VERSION, see src/lib.rs); CI
# passes the release tag or "nightly" (master pushes), local builds keep the
# "dev" default.
ARG TYZ_VERSION=dev

# Cross toolchain layer: re-run only when the toolchain pin changes. The
# rustup calls run INSIDE apps/agent so the pinned toolchain from
# rust-toolchain.toml is the one that receives the target.
COPY apps/agent/rust-toolchain.toml ./apps/agent/rust-toolchain.toml
RUN if [ "$TARGETARCH" = "arm64" ]; then \
        apt-get update && apt-get install -y --no-install-recommends gcc-aarch64-linux-gnu && \
        { echo 'export TARGET=aarch64-unknown-linux-gnu'; \
          echo 'export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc'; } > /env.sh; \
    else \
        { echo 'export TARGET=x86_64-unknown-linux-gnu'; \
          echo 'export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc'; } > /env.sh; \
    fi && \
    cd apps/agent && rustup target add "$(. /env.sh; echo "$TARGET")"

# Dependency layer: re-built only when the manifests change (realm_lb's git
# rev included — Cargo.lock pins it). The placeholder lib keeps the crate
# itself from compiling; a failure here is non-fatal (the cache just misses).
COPY apps/agent/Cargo.toml apps/agent/Cargo.lock ./apps/agent/
RUN . /env.sh && mkdir -p apps/agent/src && \
    echo "// dependency warm-up placeholder" > apps/agent/src/lib.rs && \
    cd apps/agent && cargo build --release --locked --lib --target "$TARGET" || true

COPY apps/agent ./apps/agent
RUN . /env.sh && cd apps/agent && \
    cargo build --release --locked --target "$TARGET" && \
    cp "target/$TARGET/release/tyz-agent" /out-tyz-agent

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tzdata && \
    rm -rf /var/lib/apt/lists/*

# /var/lib/tyz holds .env, certs/ (platform link-TLS PEMs) and the
# last-config.json offline bootstrap cache — mount a directory or volume on
# it to keep tunnels alive across restarts. Runs as root: the agent needs
# host networking anyway, and operator-created bind mounts (the documented
# ./data layout) are root-owned, which would block a non-root container from
# writing its state.
RUN mkdir -p /var/lib/tyz
WORKDIR /var/lib/tyz
ENV HOME=/var/lib/tyz

COPY --from=build /out-tyz-agent /usr/local/bin/tyz-agent

# Exec form so SIGTERM reaches the agent directly (final stats flush)
ENTRYPOINT ["tyz-agent"]
