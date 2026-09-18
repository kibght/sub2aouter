package service

import (
	"context"

	"github.com/gin-gonic/gin"
)

func gatewayGinRequestContext(c *gin.Context) context.Context {
	if c == nil || c.Request == nil {
		return context.Background()
	}
	return c.Request.Context()
}

// BillableOverdraftResult accepts only provider-reported usage already received
// before an explicit balance stop. It never estimates tokens for missing usage.
func BillableOverdraftResult(ctx context.Context, result *ForwardResult) bool {
	return IsGatewayBalanceOverdraft(ctx) && result != nil &&
		(hasClaudeUsage(&result.Usage) || result.ImageCount > 0)
}

func BillableOpenAIOverdraftResult(ctx context.Context, result *OpenAIForwardResult) bool {
	return IsGatewayBalanceOverdraft(ctx) && result != nil &&
		(hasOpenAIUsage(&result.Usage) || result.ImageCount > 0)
}

func hasClaudeUsage(usage *ClaudeUsage) bool {
	return usage != nil && (usage.InputTokens > 0 || usage.OutputTokens > 0 ||
		usage.CacheCreationInputTokens > 0 || usage.CacheReadInputTokens > 0 ||
		usage.CacheCreation5mTokens > 0 || usage.CacheCreation1hTokens > 0 || usage.ImageOutputTokens > 0)
}

func hasOpenAIUsage(usage *OpenAIUsage) bool {
	return usage != nil && (usage.InputTokens > 0 || usage.OutputTokens > 0 ||
		usage.CacheCreationInputTokens > 0 || usage.CacheReadInputTokens > 0 ||
		usage.ImageInputTokens > 0 || usage.ImageOutputTokens > 0)
}
