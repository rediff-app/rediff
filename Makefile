.PHONY: build web install test dev-web clean

# Release binary with the frontend embedded.
build: web
	cargo build --release

web: web/node_modules
	cd web && npm run build

web/node_modules: web/package.json
	cd web && npm install
	@touch $@

install: web
	cargo install --path .

test:
	cargo test
	cd web && npx tsc --noEmit
	cd web && npm test

# Rebuild the frontend on change; a debug `cargo run` serves web/dist from disk.
dev-web: web/node_modules
	cd web && npm run watch

clean:
	cargo clean
	rm -rf web/dist
