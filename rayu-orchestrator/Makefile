.PHONY: build test test-integration tidy run vet fmt

build:
	go build ./...

test:
	go test ./...

# Integration tests (real Docker / MySQL) are guarded by the `integration` build
# tag and run in a separate lane.
test-integration:
	go test -tags=integration ./...

vet:
	go vet ./...

fmt:
	gofmt -l -w .

tidy:
	go mod tidy

run:
	go run ./cmd/orchestrator
