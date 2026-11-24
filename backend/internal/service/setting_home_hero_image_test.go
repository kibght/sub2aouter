//go:build unit

package service

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/stretchr/testify/require"
)

func TestSettingServiceHomeHeroImageRoundTrip(t *testing.T) {
	for _, image := range []string{"", "/images/hero.webp", "https://example.com/hero.webp", "data:image/png;base64,aGVybw=="} {
		t.Run(image, func(t *testing.T) {
			repo := &settingUpdateRepoStub{}
			svc := NewSettingService(repo, &config.Config{})
			require.NoError(t, svc.UpdateSettings(context.Background(), &SystemSettings{HomeHeroImage: image}))
			require.Equal(t, image, repo.updates[SettingKeyHomeHeroImage])

			loaded, err := NewSettingService(&settingGetAllRepoStub{values: repo.updates}, &config.Config{}).
				GetAllSettings(context.Background())
			require.NoError(t, err)
			require.Equal(t, image, loaded.HomeHeroImage)

			publicService := NewSettingService(&settingPublicRepoStub{values: repo.updates}, &config.Config{})
			public, err := publicService.GetPublicSettings(context.Background())
			require.NoError(t, err)
			require.Equal(t, image, public.HomeHeroImage)

			injection, err := publicService.GetPublicSettingsForInjection(context.Background())
			require.NoError(t, err)
			raw, err := json.Marshal(injection)
			require.NoError(t, err)
			var payload map[string]any
			require.NoError(t, json.Unmarshal(raw, &payload))
			require.Equal(t, image, payload["home_hero_image"])
		})
	}
}

func TestSettingServiceHomeHeroImageDefaultsToEmpty(t *testing.T) {
	settings, err := NewSettingService(&settingPublicRepoStub{values: map[string]string{}}, &config.Config{}).
		GetPublicSettings(context.Background())
	require.NoError(t, err)
	require.Empty(t, settings.HomeHeroImage)
}
