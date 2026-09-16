// Package useragent provides User-Agent rotation for upstream requests
// to avoid detection and account association by upstream providers.
package useragent

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"sync/atomic"
)

// Profile represents a User-Agent configuration for a specific browser/client.
type Profile struct {
	Name      string
	UserAgent string
	Weight    int // Relative probability weight for selection
}

// Pool manages a collection of User-Agent profiles for rotation.
type Pool struct {
	profiles []Profile
	counter  atomic.Uint64
}

// DefaultUserAgents contains realistic User-Agent strings from various browsers and versions.
// These are actual User-Agent strings captured from real browsers to avoid detection.
var DefaultUserAgents = []Profile{
	// Chrome on Windows (40% weight)
	{
		Name:      "chrome_120_win",
		UserAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		Weight:    40,
	},
	{
		Name:      "chrome_121_win",
		UserAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
		Weight:    40,
	},

	// Chrome on macOS (30% weight)
	{
		Name:      "chrome_120_mac",
		UserAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		Weight:    30,
	},
	{
		Name:      "chrome_121_mac",
		UserAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
		Weight:    30,
	},

	// Edge on Windows (15% weight)
	{
		Name:      "edge_120_win",
		UserAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
		Weight:    15,
	},

	// Safari on macOS (15% weight)
	{
		Name:      "safari_17_mac",
		UserAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
		Weight:    15,
	},
}

// NewPool creates a new User-Agent pool with the given profiles.
func NewPool(profiles []Profile) *Pool {
	if len(profiles) == 0 {
		profiles = DefaultUserAgents
	}
	return &Pool{profiles: profiles}
}

// SelectByAccountID returns a deterministic User-Agent for the given account ID.
// The same account ID always returns the same User-Agent (stable per account).
func (p *Pool) SelectByAccountID(accountID int64) string {
	if len(p.profiles) == 0 {
		return DefaultUserAgents[0].UserAgent
	}

	// Use account ID as seed for deterministic selection
	hash := sha256.Sum256([]byte(fmt.Sprintf("account:%d", accountID)))
	index := binary.BigEndian.Uint64(hash[:8]) % uint64(len(p.profiles))

	return p.profiles[index].UserAgent
}

// RotateRoundRobin returns the next User-Agent in round-robin fashion.
// Use this for requests that don't have an account ID (e.g., OAuth flows).
func (p *Pool) RotateRoundRobin() string {
	if len(p.profiles) == 0 {
		return DefaultUserAgents[0].UserAgent
	}

	index := p.counter.Add(1) % uint64(len(p.profiles))
	return p.profiles[index].UserAgent
}

// SelectWeighted returns a User-Agent based on weight distribution.
// Higher weight profiles are more likely to be selected.
func (p *Pool) SelectWeighted() string {
	if len(p.profiles) == 0 {
		return DefaultUserAgents[0].UserAgent
	}

	// Calculate total weight
	totalWeight := 0
	for _, profile := range p.profiles {
		totalWeight += profile.Weight
	}

	if totalWeight == 0 {
		return p.RotateRoundRobin()
	}

	// Select based on weight
	counter := int(p.counter.Add(1))
	position := counter % totalWeight

	cumulative := 0
	for _, profile := range p.profiles {
		cumulative += profile.Weight
		if position < cumulative {
			return profile.UserAgent
		}
	}

	return p.profiles[0].UserAgent
}

// DefaultPool is the global User-Agent pool instance.
var DefaultPool = NewPool(DefaultUserAgents)

