'use strict';

// Public configuration: only URLs belong here, never an API key.
// The Compare tab can also use a temporary key entered in API settings.
// These optional backend defaults work with: node compare/server.mjs
// For a separately hosted backend, replace both paths with its HTTPS URLs.
window.CHATBOT_COMPARISON_CONFIG = Object.freeze({
  endpoint: '/api/chat',
  statusEndpoint: '/api/status',
  timeoutMs: 60000
});
