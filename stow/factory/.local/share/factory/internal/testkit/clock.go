package testkit

import (
	"context"
	"sync"
	"time"
)

// FakeClock is a clock that moves only when something sleeps on it, so a
// test never waits for a poll interval.
type FakeClock struct {
	mu    sync.Mutex
	start time.Time
	slept time.Duration
}

// NewFakeClock starts at the real time now.
func NewFakeClock() *FakeClock { return &FakeClock{start: time.Now()} }

// Now is the start plus everything slept.
func (c *FakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.start.Add(c.slept)
}

// Sleep advances the clock by d and returns at once.
func (c *FakeClock) Sleep(ctx context.Context, d time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.slept += d
	return nil
}
