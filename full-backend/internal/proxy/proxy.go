// Package proxy forwards chat-completion requests to an upstream OpenAI-compatible
// provider, streaming the SSE response back to the client while capturing the
// token usage the provider reports (the authoritative basis for credit billing).
package proxy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Client is the shared HTTP client. No overall timeout — long streams rely on
// the request context for cancellation; only the dial/idle are bounded.
var Client = &http.Client{
	Transport: &http.Transport{
		MaxIdleConns:        100,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: 10 * time.Second,
	},
}

// Usage is the token accounting returned by the provider.
type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

func newReq(ctx context.Context, url, apiKey string, body []byte) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)
	return req, nil
}

// parseUsageLine extracts a non-empty usage object from a single SSE `data:` line.
func parseUsageLine(line []byte) *Usage {
	s := bytes.TrimSpace(line)
	if !bytes.HasPrefix(s, []byte("data:")) {
		return nil
	}
	payload := bytes.TrimSpace(s[len("data:"):])
	if len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
		return nil
	}
	var chunk struct {
		Usage *Usage `json:"usage"`
	}
	if json.Unmarshal(payload, &chunk) != nil {
		return nil
	}
	if chunk.Usage != nil && chunk.Usage.TotalTokens > 0 {
		return chunk.Usage
	}
	return nil
}

// Stream proxies a streaming completion. It owns the response once it starts
// writing; `wrote` reports whether any bytes/headers were sent to the client.
// On a pre-flight failure (wrote=false) the caller should write an error.
func Stream(ctx context.Context, w http.ResponseWriter, upstreamURL, apiKey string, body []byte) (usage *Usage, wrote bool, err error) {
	req, err := newReq(ctx, upstreamURL, apiKey, body)
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("Accept", "text/event-stream")

	resp, err := Client.Do(req)
	if err != nil {
		return nil, false, err
	}
	defer resp.Body.Close()

	flusher, _ := w.(http.Flusher)

	// Pass an upstream error through verbatim so the client sees the reason.
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(b)
		return nil, true, fmt.Errorf("upstream status %d", resp.StatusCode)
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	if flusher != nil {
		flusher.Flush()
	}

	reader := bufio.NewReader(resp.Body)
	for {
		line, rerr := reader.ReadBytes('\n')
		if len(line) > 0 {
			if _, werr := w.Write(line); werr != nil {
				return usage, true, werr // client disconnected
			}
			if flusher != nil {
				flusher.Flush()
			}
			if u := parseUsageLine(line); u != nil {
				usage = u
			}
		}
		if rerr != nil {
			break // EOF or upstream/ctx error ends the stream
		}
	}
	return usage, true, nil
}

// Complete proxies a non-streaming completion, returning the upstream status,
// raw body, and parsed usage for the caller to write + meter.
func Complete(ctx context.Context, upstreamURL, apiKey string, body []byte) (usage *Usage, status int, respBody []byte, err error) {
	req, err := newReq(ctx, upstreamURL, apiKey, body)
	if err != nil {
		return nil, 0, nil, err
	}
	resp, err := Client.Do(req)
	if err != nil {
		return nil, 0, nil, err
	}
	defer resp.Body.Close()
	respBody, _ = io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusOK {
		var parsed struct {
			Usage *Usage `json:"usage"`
		}
		if json.Unmarshal(respBody, &parsed) == nil && parsed.Usage != nil {
			usage = parsed.Usage
		}
	}
	return usage, resp.StatusCode, respBody, nil
}
