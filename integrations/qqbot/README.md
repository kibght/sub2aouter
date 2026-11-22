# QQ bot plugin

`kinght_status_plugin/` is the reviewed MaiBot plugin source. It contains no runtime configuration or binding data.

Version 1.4.12 uses `/api/v1/admin/bot/*` and `/api/v1/admin/bot-bindings/redeem`. Keep these endpoints in independent router groups with administrator authentication before Bot authentication. Bot authentication must replace the administrator request subject with the bound user before handlers and user rate limiting run.

Upgrade the website and plugin together. Preserve the existing plugin data directory and set the new administrator key in the plugin configuration (which takes precedence over `KINGHT_ADMIN_API_KEY`). No user rebinding is required merely for an administrator key rotation.

Run local regressions from the repository root:

```sh
python -m unittest discover -s integrations/qqbot/tests -p 'test_kinght*.py'
```

The tests use local HTTP servers and fake host APIs; they do not contact the website or send QQ messages. Package only the files inside `kinght_status_plugin/`, excluding caches, tests, and runtime data.
