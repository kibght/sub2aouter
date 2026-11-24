<template>
<div class="trust-home reference-home apophis-home" id="top"><a class="skip-link" href="#main">跳至主要内容</a>
<header class="site-header" data-test="home-nav" v-bind:data-state="isScrolled ? 'compact' : 'expanded'">
<div class="container nav-inner"><a class="brand " href="#top" v-bind:aria-label="siteName"><img class="brand-logo" v-bind:src="siteLogo || '/logo.svg'" v-bind:alt="siteName" v-on:load="updateLogoRatio" v-bind:class="{ 'configured-logo': !wideLogo }"><span class="configured-brand-name" v-if="!wideLogo">{{ siteName }}</span></a>
<nav class="primary-nav " aria-label="主导航" id="home-mobile-menu" v-bind:class="{ 'is-open': menuOpen }" v-on:click="menuOpen = false"><a href="#features">产品优势</a><a href="#security">安全隐私</a><a href="#models">模型价格</a><a target="_blank" rel="noopener noreferrer" v-if="docUrl" v-bind:href="docUrl">接入文档 <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up-right"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path>
</svg></a>
</nav>
<div class="nav-actions"><RouterLink class="login-link" to="/login" v-if="!isAuthenticated">登录</RouterLink><RouterLink class="button button-small button-lime" v-bind:to="dashboardDestination">进入控制台 <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up-right"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path>
</svg></RouterLink><button class="mobile-menu icon-button" aria-label="打开导航" v-bind:aria-expanded="menuOpen" aria-controls="home-mobile-menu" v-on:click="menuOpen = !menuOpen">
<svg xmlns="http://www.w3.org/2000/svg" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-menu"><line x1="4" x2="20" y1="12" y2="12"></line><line x1="4" x2="20" y1="6" y2="6"></line><line x1="4" x2="20" y1="18" y2="18"></line>
</svg></button>
</div>
</div>
</header>
<main id="main">
<section class="hero" aria-labelledby="hero-heading">
<HomeHeroScene v-bind:image-url="heroImage" />
<div class="hero-shade">
</div>
<div class="container hero-inner">
<div class="hero-content">
<div class="hero-kicker"><span></span> BUILT ON TRUST. MADE FOR BUILDERS. <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up-right"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path>
</svg>
</div>
<h1 id="hero-heading">{{ siteName }}</h1>
<p class="hero-subtitle">{{ siteSubtitle }}</p>
<p>一个 API 入口，连接全球大模型。<br>安全的连接，透明的用量。你的数据，始终属于你。</p>
<div class="hero-actions"><RouterLink class="button button-lime" v-bind:to="dashboardDestination">开始构建 <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up-right"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path>
</svg></RouterLink><a class="button button-outline" href="#security">了解安全保障 <svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-right"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path>
</svg></a>
</div>
<div class="hero-proof"><span>
<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-code-xml"><path d="m18 16 4-4-4-4"></path><path d="m6 8-4 4 4 4"></path><path d="m14.5 4-5 16"></path>
</svg> OpenAI 兼容接口</span><i></i><span>按量计费</span><i></i><span>HTTPS 加密</span>
</div>
</div>
<div class="hero-side-note" aria-hidden="true"><span>ONE GATEWAY.</span><span>MORE POSSIBILITIES.</span>
</div><a class="hero-scroll" href="#features" aria-label="浏览产品优势">
<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-down"><path d="M12 5v14"></path><path d="m19 12-7 7-7-7"></path>
</svg><span>向下探索</span></a>
</div>
<div class="hero-bottom-line"><span>DESIGNED FOR BUILDERS</span><span>AI WITHOUT THE FRICTION</span>
</div>
</section>
<section class="provider-strip" aria-label="接入的模型生态">
<div class="container provider-inner"><span class="provider-label">你的下一次创造，<br>不止一种选择。</span>
<div class="provider-wordmarks"><span class="wordmark-openai">OpenAI</span><span class="wordmark-claude"><i aria-hidden="true">✳</i> Claude</span><span class="wordmark-grok">/ Grok</span><span class="wordmark-codex">
<svg xmlns="http://www.w3.org/2000/svg" width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-terminal"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" x2="20" y1="19" y2="19"></line>
</svg> Codex</span><RouterLink class="more-models" to="/model-plaza">更多模型 <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up-right"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path>
</svg></RouterLink>
</div>
</div>
</section>
<section class="capabilities section-pad" id="features" aria-labelledby="features-heading">
<div class="container">
<div class="trust-heading"><span class="section-index">01 / BUILT FOR YOUR NEXT</span>
<h2 id="features-heading">强大的模型。<br><span>简单的连接。</span>
</h2>
<p>从第一行代码，到每一次真实调用。<br>把复杂留给我们，把创造留给你。</p>
</div>
<div class="capability-grid">
<article class="capability">
<div class="capability-top">
<svg xmlns="http://www.w3.org/2000/svg" width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-route"><circle cx="6" cy="19" r="3"></circle><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"></path><circle cx="18" cy="5" r="3"></circle>
</svg><span>01</span>
</div>
<h3>官方同源，连接模型原生能力。</h3>
<p>面向 GPT 与 Claude Code 等开发场景，提供统一的模型接入入口，支持长连接与流式响应。</p>
<div class="capability-tags"><span>GPT</span><span>Claude Code</span><span>流式输出</span>
</div>
</article>
<article class="capability">
<div class="capability-top">
<svg xmlns="http://www.w3.org/2000/svg" width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-code-xml"><path d="m18 16 4-4-4-4"></path><path d="m6 8-4 4 4 4"></path><path d="m14.5 4-5 16"></path>
</svg><span>02</span>
</div>
<h3>熟悉的接口，更轻松的迁移。</h3>
<p>兼容 OpenAI API 格式。按所选模型配置 Base URL 与 API Key，让现有 SDK 和业务快速接入。</p>
<div class="capability-tags"><span>OpenAI SDK</span><span>Base URL</span><span>API Key</span>
</div>
</article>
<article class="capability">
<div class="capability-top">
<svg xmlns="http://www.w3.org/2000/svg" width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-zap"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"></path>
</svg><span>03</span>
</div>
<h3>多线路接入，让响应更顺畅。</h3>
<p>为不同任务选择合适的模型与线路，支持流式输出，让每一次生成都及时呈现。</p>
<div class="capability-tags"><span>多模型线路</span><span>Streaming</span><span>灵活选择</span>
</div>
</article>
<article class="capability">
<div class="capability-top">
<svg xmlns="http://www.w3.org/2000/svg" width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-receipt-text"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"></path><path d="M14 8H8"></path><path d="M16 12H8"></path><path d="M13 16H8"></path>
</svg><span>04</span>
</div>
<h3>按量计费，让每一笔都有据可查。</h3>
<p>按 Token 用量计费，输入、输出与缓存价格清晰呈现。余额、账单与调用明细，在控制台统一管理。</p>
<div class="capability-tags"><span>Token 计费</span><span>调用明细</span><span>余额管理</span>
</div>
</article>
</div>
</div>
</section>
<section class="privacy-section section-pad" id="security" aria-labelledby="security-heading">
<div class="container">
<div class="privacy-intro">
<div class="privacy-copy"><span class="section-index">
<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-shield-check"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"></path><path d="m9 12 2 2 4-4"></path>
</svg> 安全与隐私 / PRIVACY FIRST</span>
<h2 id="security-heading">您的请求，<br><span>只用于提供服务</span>
</h2>
<p>API Key、分组、模型白名单和预算策略统一管理。</p>
<div class="privacy-tags"><span>
<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check"><path d="M20 6 9 17l-5-5"></path>
</svg>密钥隔离</span><span>
<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check"><path d="M20 6 9 17l-5-5"></path>
</svg>可限额</span><span>
<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check"><path d="M20 6 9 17l-5-5"></path>
</svg>账单可查</span>
</div>
</div>
<div class="privacy-diagram" aria-label="统一 API 入口">
<div class="diagram-caption">
<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-lock-keyhole"><circle cx="12" cy="16" r="1"></circle><rect x="3" y="10" width="18" height="12" rx="2"></rect><path d="M7 10V7a5 5 0 0 1 10 0v3"></path>
</svg> ACCESS UNDER YOUR CONTROL <span>API Key</span>
</div>
<div class="secure-route">
<div class="route-end">
<svg xmlns="http://www.w3.org/2000/svg" width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-code-xml"><path d="m18 16 4-4-4-4"></path><path d="m6 8-4 4 4 4"></path><path d="m14.5 4-5 16"></path>
</svg><span>你的应用</span>
</div>
<div class="route-wire"><i></i>
</div>
<div class="secure-core">
<svg xmlns="http://www.w3.org/2000/svg" width="53" height="53" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-shield-check"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"></path><path d="m9 12 2 2 4-4"></path>
</svg><span>{{ siteName }}</span>
</div>
<div class="route-wire wire-second"><i></i>
</div>
<div class="route-end">
<svg xmlns="http://www.w3.org/2000/svg" width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-zap"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"></path>
</svg><span>大模型</span>
</div>
</div>
<div class="secure-receipt"><span>
<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-fingerprint"><path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"></path><path d="M14 13.12c0 2.38 0 6.38-1 8.88"></path><path d="M17.29 21.02c.12-.6.43-2.3.5-3.02"></path><path d="M2 12a10 10 0 0 1 18-6"></path><path d="M2 16h.01"></path><path d="M21.8 16c.2-2 .131-5.354 0-6"></path><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"></path><path d="M8.65 22c.21-.66.45-1.32.57-2"></path><path d="M9 6.8a6 6 0 0 1 9 5.2v2"></path>
</svg> API Key</span><strong>密钥独立可控</strong><span>
<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-activity"><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"></path>
</svg> Token 用量</span><strong>用于计费</strong>
</div>
<div class="diagram-footer"><span>连接能力，尊重边界。</span>
<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-shield-check"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"></path><path d="m9 12 2 2 4-4"></path>
</svg>
</div>
</div>
</div>
<div class="privacy-grid">
<article>
<svg xmlns="http://www.w3.org/2000/svg" width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-lock-keyhole"><circle cx="12" cy="16" r="1"></circle><rect x="3" y="10" width="18" height="12" rx="2"></rect><path d="M7 10V7a5 5 0 0 1 10 0v3"></path>
</svg>
<h3>统一 API 入口</h3>
<p>一套 Base URL 和 Key 连接多平台模型，降低迁移成本。</p><span>ONE GATEWAY. MORE POSSIBILITIES.</span>
</article>
<article>
<svg xmlns="http://www.w3.org/2000/svg" width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-fingerprint"><path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"></path><path d="M14 13.12c0 2.38 0 6.38-1 8.88"></path><path d="M17.29 21.02c.12-.6.43-2.3.5-3.02"></path><path d="M2 12a10 10 0 0 1 18-6"></path><path d="M2 16h.01"></path><path d="M21.8 16c.2-2 .131-5.354 0-6"></path><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"></path><path d="M8.65 22c.21-.66.45-1.32.57-2"></path><path d="M9 6.8a6 6 0 0 1 9 5.2v2"></path>
</svg>
<h3>安全限流</h3>
<p>支持模型白名单、额度、限速和审计，适合团队协作。</p><span>SET YOUR OWN LIMITS</span>
</article>
<article>
<svg xmlns="http://www.w3.org/2000/svg" width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-key-round"><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"></path><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"></circle>
</svg>
<h3>密钥独立可控</h3>
<p>API Key、分组、模型白名单和预算策略统一管理。</p><span>ACCESS UNDER YOUR CONTROL</span>
</article>
<article>
<svg xmlns="http://www.w3.org/2000/svg" width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-receipt-text"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"></path><path d="M14 8H8"></path><path d="M16 12H8"></path><path d="M13 16H8"></path>
</svg>
<h3>用量透明可查</h3>
<p>请求、费用、模型、分组和账号状态集中查看。</p><span>EVERY TOKEN ACCOUNTED FOR</span>
</article>
</div>
</div>
</section>
<section class="performance-section section-pad" id="performance" aria-labelledby="performance-heading">
<div class="container">
<div class="performance-heading">
<div><span class="section-index">03 / 服务表现</span>
<h2 id="performance-heading">一个入口，<br><span>覆盖主流大模型平台</span>
</h2>
</div>
</div>
<div class="metrics-grid" data-test="hero-stats">
<article><span class="metric-unit">ONE / GATEWAY</span><strong>1 URL</strong>
<h3>统一 API 入口</h3>
</article>
<article class="model-availability"><span class="metric-unit">MODELS / AVAILABLE</span><strong aria-live="polite" aria-atomic="true">{{ modelCount === null ? '—' : modelCount }}</strong>
<h3>可接入模型数</h3>
</article>
<article><span class="metric-unit">USAGE / TRANSPARENT</span><strong>Token<span>计费</span></strong>
<h3>实时用量计费</h3>
</article>
</div>
<div class="metrics-bottom">
<p>让服务表现有据可查，让每一次调用心中有数。</p><RouterLink class="text-link" v-bind:to="dashboardDestination">查看我的用量 <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up-right"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path>
</svg></RouterLink>
</div>
</div>
</section>
<HomeModelPricing v-on:model-count="modelCount = $event" />
<section id="developers" class="developer-section section-pad" aria-labelledby="developers-heading">
<div class="container">
<div class="integration-grid">
<div class="integration-copy"><span class="section-index">05 / 为开发而生</span>
<h2 id="developers-heading">少一些配置，<br>多一些创造。</h2>
<p>沿用熟悉的 OpenAI SDK。<br>连接 {{ siteName }}，把精力留给你的产品。</p>
<div class="endpoint"><span>BASE URL / RESPONSES</span>
<div><code data-test="endpoint-url">{{ endpointUrl }}</code><span class="copy-control"><button class="icon-button" type="button" title="复制接口地址" aria-label="复制接口地址" data-test="copy-endpoint" v-on:click="copyValue(endpointUrl, 'endpoint')">
<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-copy"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>
</svg></button><span class="copy-feedback" role="status">{{ copyMessage('endpoint') }}</span></span>
</div>
</div><a target="_blank" rel="noopener noreferrer" class="text-link" v-if="docUrl" v-bind:href="docUrl">阅读接入文档 <svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up-right"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path>
</svg></a>
</div>
<div class="code-window">
<div class="code-toolbar">
<div class="segment language-tabs" role="tablist" aria-label="示例代码语言"><button id="code-tab-Python" role="tab" v-bind:class="{ active: codeLanguage === 'Python' }" v-bind:aria-selected="codeLanguage === 'Python'" v-on:click="codeLanguage = 'Python'" aria-controls="home-code-example">Python</button><button id="code-tab-Node.js" role="tab" v-bind:class="{ active: codeLanguage === 'Node.js' }" v-bind:aria-selected="codeLanguage === 'Node.js'" v-on:click="codeLanguage = 'Node.js'" aria-controls="home-code-example">Node.js</button><button id="code-tab-cURL" role="tab" v-bind:class="{ active: codeLanguage === 'cURL' }" v-bind:aria-selected="codeLanguage === 'cURL'" v-on:click="codeLanguage = 'cURL'" aria-controls="home-code-example">cURL</button>
</div><span class="copy-control"><button class="icon-button" type="button" title="复制代码" aria-label="复制代码" data-test="copy-code" v-on:click="copyValue(codeExample, 'code')">
<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-copy"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>
</svg></button><span class="copy-feedback" role="status">{{ copyMessage('code') }}</span></span>
</div>
<pre class="code-body" tabindex="0" aria-label="接入示例代码" id="home-code-example" role="tabpanel" v-bind:aria-labelledby="`code-tab-${codeLanguage}`"><code><span v-for="(line, index) in codeLines" v-bind:key="index" class="code-line"><span class="line-number" aria-hidden="true">{{ index + 1 }}</span><span><span v-for="(token, tokenIndex) in line" v-bind:key="tokenIndex" v-bind:class="token.kind">{{ token.text }}</span></span></span></code>
</pre>
<div class="code-footnote">
<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-terminal"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" x2="20" y1="19" y2="19"></line>
</svg><span>OpenAI Responses 调用示例 · 请配置环境变量中的 API Key</span>
</div>
</div>
</div>
<div class="feature-row">
<article>
<svg xmlns="http://www.w3.org/2000/svg" width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-layers"><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"></path><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"></path><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"></path>
</svg>
<h3>模型选择，更自由</h3>
<p>在同一平台查看多家模型与分组，为不同任务选择合适的能力。</p>
</article>
<article>
<svg xmlns="http://www.w3.org/2000/svg" width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-git-branch"><line x1="6" x2="6" y1="3" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path>
</svg>
<h3>熟悉的开发方式</h3>
<p>支持 OpenAI 兼容接口。依照模型协议接入，减少重复配置。</p>
</article>
<article>
<svg xmlns="http://www.w3.org/2000/svg" width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-zap"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"></path>
</svg>
<h3>每一笔用量，有依据</h3>
<p>输入、输出与缓存计费清晰呈现，按实际使用选择你的分组。</p>
</article>
</div>
</div>
</section>
<section id="faq" class="faq-section section-pad" aria-labelledby="faq-heading">
<div class="container faq-layout">
<div><span class="section-index">06 / 常见问题</span>
<h2 id="faq-heading">开始之前，<br><span class="muted-heading">你可能想知道。</span>
</h2><a target="_blank" rel="noopener noreferrer" class="text-link" v-if="docUrl" v-bind:href="docUrl">更多帮助 <svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up-right"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path>
</svg></a>
</div>
<div class="faq-list">
<details class="faq-item" name="homepage-faq" open>
<summary>
<h3>{{ siteName }} 支持哪些大模型？</h3>
<svg xmlns="http://www.w3.org/2000/svg" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus"><path d="M5 12h14"></path><path d="M12 5v14"></path>
</svg>
</summary>
<div class="faq-answer">
<p>当前价格目录涵盖 OpenAI、Anthropic Claude、xAI Grok 和 Google Gemini。模型与分组会调整，请在模型广场确认所需模型的最新供应情况及可用协议。</p>
</div>
</details>
<details class="faq-item" name="homepage-faq">
<summary>
<h3>已有的应用，如何接入 {{ siteName }}？</h3>
<svg xmlns="http://www.w3.org/2000/svg" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus"><path d="M5 12h14"></path><path d="M12 5v14"></path>
</svg>
</summary>
<div class="faq-answer">
<p>在控制台创建 API Key，并按客户端及模型协议配置接口地址。OpenAI Responses SDK 的 Base URL 为 {{ apiBaseUrl }}；Chat Completions SDK 为 {{ apiBaseUrl }}/v1。模型与协议需匹配，完整配置以接入文档为准。</p>
</div>
</details>
<details class="faq-item" name="homepage-faq">
<summary>
<h3>同一个模型，为什么会有不同价格？</h3>
<svg xmlns="http://www.w3.org/2000/svg" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus"><path d="M5 12h14"></path><path d="M12 5v14"></path>
</svg>
</summary>
<div class="faq-answer">
<p>不同分组拥有独立的倍率、计费与可用性特点。首页同步公开分组配置，展示分组倍率和已确认的常规文本参考价。图片、视频、Fast 和长上下文等计费规则可能不同，最终以控制台实际计费为准。</p>
</div>
</details>
<details class="faq-item" name="homepage-faq">
<summary>
<h3>可以继续使用现有的 AI 客户端吗？</h3>
<svg xmlns="http://www.w3.org/2000/svg" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus"><path d="M5 12h14"></path><path d="M12 5v14"></path>
</svg>
</summary>
<div class="faq-answer">
<p>支持自定义接口地址与 API Key 的 OpenAI 兼容客户端通常可以接入。具体可用功能取决于客户端、所选模型和调用协议，配置前请查看接入文档并确认兼容性。</p>
</div>
</details>
</div>
</div>
</section>
<section class="closing-section">
<div class="container closing-inner"><span class="closing-label">NEXT IS YOURS.</span>
<h2>下一种可能，<br>由你来创造。</h2><RouterLink class="button button-dark" v-bind:to="dashboardDestination">开启你的下一步 <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up-right"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path>
</svg></RouterLink>
<div class="closing-signal" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span>
</div>
</div>
</section>
</main>
<footer class="site-footer">
<div class="container footer-top"><a class="brand brand-light" href="#top" v-bind:aria-label="siteName"><img class="brand-logo" v-bind:src="siteLogo || '/logo.svg'" v-bind:alt="siteName" v-on:load="updateLogoRatio" v-bind:class="{ 'configured-logo': !wideLogo }"><span class="configured-brand-name" v-if="!wideLogo">{{ siteName }}</span></a>
<p>连接模型，也连接你的下一个想法。</p>
<div class="footer-links"><RouterLink to="/model-plaza">模型广场 <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up-right"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path>
</svg></RouterLink><a target="_blank" rel="noopener noreferrer" v-if="docUrl" v-bind:href="docUrl">接入文档 <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up-right"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path>
</svg></a><RouterLink v-bind:to="dashboardDestination">控制台 <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up-right"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path>
</svg></RouterLink>
</div>
</div>
<section id="contact" class="contact-section" aria-label="联系与交流">
<div class="container">
<div class="contact-grid">
<div class="contact-channel"><a class="contact-entry" href="mqqapi://card/show_pslcard?src_type=internal&amp;version=1&amp;uin=702891993&amp;card_type=group&amp;source=qrcode" aria-label="打开 QQ 群入口 702891993">
<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-users contact-channel-icon" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
</svg><span class="contact-entry-text"><span>QQ 交流群</span><strong class="contact-number">702891993</strong></span>
<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up-right contact-entry-arrow" aria-hidden="true"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path>
</svg></a><span class="contact-copy-control"><button type="button" class="contact-icon-button" aria-label="复制 QQ 群号" data-test="copy-qq" v-on:click="copyValue('702891993', 'qq')">
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-copy"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>
</svg><span class="contact-tooltip" aria-hidden="true">复制 QQ 群号</span></button><span class="contact-copy-feedback" role="status" aria-live="polite">{{ copyMessage('qq') }}</span></span><span class="contact-qq-feedback" role="status" aria-live="polite"></span>
</div>
</div>
</div>
</section>
<div class="container footer-bottom"><span>© {{ currentYear }} {{ siteName }}</span><span>模型及商标归其各自权利人所有。</span><a href="#top">回到顶部 <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up-right"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path>
</svg></a>
</div>
</footer>
</div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore, useAppStore } from '@/stores'
import HomeHeroScene from './HomeHeroScene.vue'
import HomeModelPricing from './HomeModelPricing.vue'
import { sanitizeUrl } from '@/utils/url'
import '@/styles/aimover-reference.css'

const { t } = useI18n()
const authStore = useAuthStore()
const appStore = useAppStore()
const siteName = computed(() => appStore.cachedPublicSettings?.site_name || appStore.siteName || 'Sub2API')
const siteLogo = computed(() => sanitizeUrl(appStore.cachedPublicSettings?.site_logo || appStore.siteLogo || '', { allowRelative: true, allowDataUrl: true }))
const siteSubtitle = computed(() => appStore.cachedPublicSettings?.site_subtitle || '守护隐私，官方保真。')
const heroImage = computed(() => sanitizeUrl(appStore.cachedPublicSettings?.home_hero_image || '', { allowRelative: true, allowDataUrl: true }))
const docUrl = computed(() => sanitizeUrl(appStore.cachedPublicSettings?.doc_url || appStore.docUrl || ''))
const isAuthenticated = computed(() => authStore.isAuthenticated)
const dashboardDestination = computed(() => isAuthenticated.value ? (authStore.isAdmin ? '/admin/dashboard' : '/dashboard') : '/login')
const currentYear = new Date().getFullYear()
const isScrolled = ref(false)
const menuOpen = ref(false)
const modelCount = ref<number | null>(null)
const wideLogo = ref(false)
const codeLanguage = ref<'Python' | 'Node.js' | 'cURL'>('Python')
const copied = ref<'endpoint' | 'code' | 'qq' | null>(null)
const copyFailed = ref(false)
let copiedTimer: number | undefined
const apiBaseUrl = computed(() => {
  const safe = sanitizeUrl(appStore.cachedPublicSettings?.api_base_url || '') || window.location.origin
  return safe.replace(/\/+$/, '').replace(/\/v1$/i, '')
})
const endpointUrl = apiBaseUrl
const codeExample = computed(() => {
  const base = JSON.stringify(endpointUrl.value)
  if (codeLanguage.value === 'Node.js') return [
    "import OpenAI from 'openai';", '',
    'const client = new OpenAI({',
    '  apiKey: process.env.API_KEY,',
    '  baseURL: ' + base,
    '});', '',
    'const response = await client.responses.create({',
    '  model: process.env.MODEL_NAME,',
    '  input: "Hello, AI."',
    '});', '',
    'console.log(response.output_text);'
  ].join('\n')
  if (codeLanguage.value === 'cURL') return [
    'curl "' + endpointUrl.value + '/responses" \\',
    '  -H "Authorization: Bearer $API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    "  -d '{",
    '    "model": "<MODEL_NAME>",',
    '    "input": "Hello, AI."',
    "  }'"
  ].join('\n')
  return [
    'from openai import OpenAI',
    'import os', '',
    'client = OpenAI(',
    '    api_key=os.environ["API_KEY"],',
    '    base_url=' + base,
    ')', '',
    'response = client.responses.create(',
    '    model=os.environ["MODEL_NAME"],',
    '    input="Hello, AI."',
    ')', '',
    'print(response.output_text)'
  ].join('\n')
})
const codeLines = computed(() => codeExample.value.split('\n').map(line =>
  line.split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b(?:from|import|const|await|new|print)\b)/g)
    .map(text => ({ text, kind: /^["']/.test(text) ? 'syntax-string' : /^(from|import|const|await|new|print)$/.test(text) ? 'syntax-keyword' : '' }))
))
function updateLogoRatio(event: Event) {
  const image = event.target as HTMLImageElement
  wideLogo.value = image.naturalWidth / image.naturalHeight >= 3
}
function updateScrollState() { isScrolled.value = window.scrollY > 24 }
function copyMessage(kind: 'endpoint' | 'code' | 'qq') {
  return copied.value === kind ? t(copyFailed.value ? 'common.copyFailed' : 'common.copied') : ''
}
async function copyValue(value: string, kind: 'endpoint' | 'code' | 'qq') {
  window.clearTimeout(copiedTimer)
  copied.value = kind
  copyFailed.value = false
  try { await navigator.clipboard.writeText(value) }
  catch { copyFailed.value = true }
  copiedTimer = window.setTimeout(() => { copied.value = null; copyFailed.value = false }, 2000)
}
onMounted(() => { updateScrollState(); window.addEventListener('scroll', updateScrollState, { passive: true }) })
onBeforeUnmount(() => { window.removeEventListener('scroll', updateScrollState); window.clearTimeout(copiedTimer) })
</script>

<style scoped>
.reference-home { line-height: normal; }
.reference-home svg { display: inline-block; }
.reference-home .brand-logo.configured-logo { width: 35px; height: 35px; aspect-ratio: auto; object-fit: contain; }
.reference-home .configured-brand-name { max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.reference-home .hero h1 { overflow-wrap: anywhere; }
.reference-home .secure-core > span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.reference-home .contact-grid { grid-template-columns: minmax(0, 1fr); }
@media (max-width: 767px) {
  .reference-home .brand { min-width: 0; flex-shrink: 1; }
  .reference-home .configured-brand-name { max-width: 115px; }
  .reference-home .brand-logo.configured-logo { width: 30px; height: 30px; flex-shrink: 0; }
}
</style>
