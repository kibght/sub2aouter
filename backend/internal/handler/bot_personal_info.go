package handler

import (
	"context"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/pkg/usagestats"
	middleware2 "github.com/Wei-Shaw/sub2api/internal/server/middleware"

	"github.com/gin-gonic/gin"
)

const (
	botPersonalInfoRPMWindowSeconds = 60
	botPersonalInfoMetricsTimeout   = 2 * time.Second
)

type botConcurrencyReader interface {
	GetUserConcurrency(ctx context.Context, userID int64) (int, error)
}

func (h *BotHandler) SetConcurrencyReader(reader botConcurrencyReader) {
	h.concurrency = reader
}

type botPersonalInfoResponse struct {
	ID                 int64   `json:"id"`
	Username           string  `json:"username"`
	Balance            float64 `json:"balance"`
	Concurrency        int     `json:"concurrency"`
	CurrentConcurrency *int    `json:"current_concurrency"`
	CurrentRPM         *int64  `json:"current_rpm"`
	RPMWindowSeconds   int     `json:"rpm_window_seconds"`
}

// PersonalInfo returns the bound user's profile and recent activity.
// GET /api/v1/bot/personal-info
func (h *BotHandler) PersonalInfo(c *gin.Context) {
	if h == nil || h.users == nil {
		response.InternalError(c, "User service is not available")
		return
	}
	subject, ok := middleware2.GetAuthSubjectFromContext(c)
	if !ok || subject.UserID <= 0 {
		response.Unauthorized(c, "User not authenticated")
		return
	}
	ctx := c.Request.Context()
	user, err := h.users.GetByID(ctx, subject.UserID)
	if err != nil {
		response.ErrorFrom(c, err)
		return
	}
	if user == nil {
		response.NotFound(c, "User not found")
		return
	}

	result := botPersonalInfoResponse{
		ID:               user.ID,
		Username:         user.Username,
		Balance:          user.Balance,
		Concurrency:      user.Concurrency,
		RPMWindowSeconds: botPersonalInfoRPMWindowSeconds,
	}
	end := time.Now().UTC()
	start := end.Add(-time.Duration(botPersonalInfoRPMWindowSeconds) * time.Second)

	// Unlimited users bypass slot tracking, so their counts are incomplete.
	// Independent deadlines keep a failed metric from discarding the other one.
	if user.Concurrency > 0 && h.concurrency != nil {
		metricCtx, cancel := context.WithTimeout(ctx, botPersonalInfoMetricsTimeout)
		count, countErr := h.concurrency.GetUserConcurrency(metricCtx, subject.UserID)
		cancel()
		if countErr == nil {
			result.CurrentConcurrency = &count
		}
	}
	if h.usage != nil {
		metricCtx, cancel := context.WithTimeout(ctx, botPersonalInfoMetricsTimeout)
		stats, statsErr := h.usage.GetStatsWithFilters(metricCtx, usagestats.UsageLogFilters{
			UserID:    subject.UserID,
			StartTime: &start,
			EndTime:   &end,
		})
		cancel()
		if statsErr == nil && stats != nil {
			result.CurrentRPM = &stats.TotalRequests
		}
	}
	response.Success(c, result)
}
