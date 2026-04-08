.PHONY: proto build test lint clean

PROTO_DIR := ../nexus-ai/proto

proto:
	cd $(PROTO_DIR) && buf generate --template $(CURDIR)/buf.gen.ts.yaml --include-imports -o $(CURDIR)

build:
	pnpm build

test:
	pnpm test

lint:
	pnpm lint

clean:
	rm -rf dist
