# Changelog

## Unreleased

### Added

- `get_templates` takes `search`, which matches a template's id, name, tags or dates, and sorts with `order_by` (`id`, `name`, `is_draft`, `created_at` or `updated_at`; `updated_at` when left out) and `order_direction` (`desc` when left out); the API ignores all three when `name` or `tags` is set. `get_workspaces` takes `search`, `order_by`, `order_direction` and `activated` (`1` or `0`), and `get_documents` takes `search` and `format` (`pdf` or `html`).
- The generate tools take `attachments`, PDF or XML files embedded into the generated PDF (each a `name` ending in `.pdf` or `.xml`, and its base64 `content`), `print`, which opens the print dialog when the PDF is opened, and `empty_labels`, the label positions to leave empty at the start of the first sheet. `template.id` may be a public template id, and `template.data` a public URL that returns the JSON data or the data as a JSON string; `open_editor` takes `data` the same way, and `create_facturx_einvoice` a public template id too. Before, the tools refused these before they reached the API.
- `create_einvoice` takes every `type` the API has: `XRECHNUNG-UBL`, `XRECHNUNG-CII` and the Factur-X profiles (`Factur-X-XRechnung`, `Factur-X-Extended`, `Factur-X-EN16931`, `Factur-X-Basic`, `Factur-X-BasicWL`, `Factur-X-Minimum`) as well as `UBL` and `CII`.
- `make_accessible` answers with a `url` or a `viewer` link as well as a file or base64, and lists the processing `options` it takes.

### Changed

- The generate tools offer `format` `pdf` and `html` only, as the API's spec does: `xlsx` and `zip` are deprecated, and the tools now refuse them before they reach the API.
- The tools refuse what the API refuses with a 422, before it reaches the API: a template name that is empty or longer than 120 characters, a workspace identifier longer than 120, a document name longer than 255, a callback, URL-to-PDF or QR code logo URL that is not https, QR code content longer than 4296 characters or a colour that is not hex, an imported `form` without its `name` and `actions`, and a Factur-X `template` without its `id` and `data`. A page's `layout` may be the empty array older templates store. `docs/apiv4.json` is the spec the API's production release serves (4.0.35), and the tool catalogue test now finds no field where a tool and the spec differ.

## 5.4.0 — 2026-11-11

### Added

- A page takes a background colour: `backgroundColor` on a page of `create_template`, `update_template` and `validate_template`, in hex (`#RRGGBB` or `#RGB`; empty or `null` for none). It fills every sheet the page runs onto, edge to edge, under everything on it, its background image included; on a sheet of labels it fills each label. A colour that is not hex is refused before it reaches the API. The template builder's `update_page` step sets it on one page or on every page without resending the template. Needs the API release with the page background colour; before it, the colour is not kept.
- A page background colour takes an alpha: `#RRGGBBAA`, `#RGBA`, `rgb()` or `rgba()`, as well as `#RRGGBB` and `#RGB`. A translucent one is lighter, the white of the paper showing through. `docs/apiv4.json` is the API's 4.0.35 spec. Components take an `opacity` and colours with an alpha too; `get_template_schema` and the builder guide describe them. Needs the API release with them; before it, an alpha is refused.
- `preview_template` shows up to 3 pages of a template as PNG images in the chat, in one call: a saved template by its `id`, with a `version_id` for one of its versions, or a template not saved yet by its `definition`, as `create_template` takes it. `pages` is one page or a range, the first page when left out, and `resolution` is 72 to 150 DPI, 100 when left out. Every page carries a PREVIEW stamp; a preview uses no credits and stores nothing. It needs `documents:write`. Needs the API release with `POST /documents/preview`; before it, the tool answers 404.
- `show_pdf_pages` shows up to 3 pages of a PDF, from a public URL or base64, as PNG images in the chat, where `convert_pdf_to_image` answers with a zip file. It takes `pages` and `resolution` as `preview_template` does, is charged as a PDF to image conversion for each page shown, and refuses a range of more than 3 pages before it reaches the API. It needs `pdf:write`.
- A page says how its background image covers the page: `backgroundImageFit` on a page of `create_template`, `update_template` and `validate_template`, `stretch` (the default, as when none is set), `contain` (fitted inside the page, keeping its proportions) or `cover` (filling the page, keeping its proportions, what overflows cut off), centred. A background image can be an SVG. A fit that is not one of the three is refused before it reaches the API. The template builder's `update_page` step sets it too. Needs the API release with it; before it, the fit is not kept.
- The server instructions and `show_pdf_pages` point clients at `preview_template` to look at a template, and tell them not to generate a document for that: `generate_document` uses credits, and `output: url` stores the document for 30 days.
- `open_editor` opens the editor in Japanese (`ja`) and Portuguese (`pt`) too, so its `language` takes the eight languages the API's spec lists: `en`, `et`, `cs`, `sk`, `ru`, `de`, `ja` and `pt`. Before, the tool refused them before they reached the API.

## 5.3.0 — 2026-11-02

### Added

- `list_fonts` lists the fonts the workspace's templates can use, so a client picks a `fontFamily` instead of guessing one; an unknown font is drawn with Open Sans. Each font has its `id`, its name, the styles it has glyphs of its own for, and the Unicode blocks it has at least half of, in percent. `covers` keeps only the fonts that can draw every character of a text, such as `₹` or `✓`. Needs the API release with `GET /fonts` (PGA-4180); before it, the tool answers 404.
- `get_form_schema` returns the form JSON schema, as `get_template_schema` does for templates. It needs no scope.
- `convert_url_to_pdf` can wait for a page that keeps loading after its network settles, such as a single-page application: `wait_for_css` waits for an element (`wait_for_css_state`: `present` or `visible`), `wait_for_js` for an expression to be true, up to `wait_timeout` seconds, and `on_wait_timeout` either fails or prints the page as it is.
- `get_forms` takes `search`, which matches a form's name or id, and sorts with `order_by` and `order_direction`.

### Changed

- `create_form` and `update_form` take every field type the API does: `select`, `multi-select`, `table`, `image` and `pdf` as well as text, numbers, dates and signatures. A field can have a `default`, a `description`, and `subRows`: the choices of a select field, or the columns of a table. The tools now refuse a form without a name, actions or fields, and a field without its label, name, type and `required`, as the API does. `import_form` no longer offers `fields`: an imported form's fields come from the PDF.

### Fixed

- `update_template` no longer needs `name`. An update replaces only the top-level fields it sends, so `{"fontSubsetting": false}` changes that setting and keeps the stored name; the tool refused it before it reached the API. Needs the API release that accepts an update without a name (PGA-4225); before it, the API answers 422. `create_template` and `validate_template` still need a name.
- `create_template`, `update_template` and `validate_template` take every page format the API does: A2, A3, A4, A5, letter, label and custom, where they took only A4, letter and custom and refused an A3 template before it reached the API. Any other size is custom with `width` and `height`. A layout needs `format`, `orientation` and all four `margins`, as the API already required; the tools now say so, and refuse a layout without them instead of passing on the API's 422. `rotation` and `emptyLabels` are whole numbers, and `components` points to `get_template_schema` for each `cls`'s fields. A page's `margins` are its right and bottom only, as the API stores them; its top and left are the layout's. Needs the API release where A2 and A3 have a size of their own (PGA-4204); before it, an A2 or A3 layout sent without `width` and `height` gets A4's size.
- `convert_url_to_pdf` and `convert_html_to_pdf` work with only the URL or the HTML. The API now applies the defaults the spec documents, `a4` and `base64`, and names the document; since 5.2.1, which sends only the arguments the client gave, leaving out `paper_size`, `filename` or `output` got a 422. Needs the API release with PGA-4228; before it, send all three. The tools also require what the API does, and refuse a call without it instead of passing on a 422: the `url` or `content` to convert, a batch's `template`, a new workspace's `identifier`, and the `callback` and its `url` for asynchronous generation.

## 5.2.1 — 2026-10-28

### Fixed

- A tool call sends only the arguments the client gave. Validation filled in every schema default the client left out, so `update_template` without `fontSubsetting` or `barcodeAsImage` set a stored `true` back to `false`, and document tools sent the author `"Organization name"` in the metadata. The API applies its own defaults to what is missing. The tool schemas still show the defaults.

## 5.2.0 — 2026-10-27

### Changed

- `update_template` and the server instructions point to the template builder for changing a few components: `run_builder_tool` with `patch_component`, `add_component` or `remove_component` changes one component without resending the template. `update_template`'s description no longer says the whole template is replaced; each top-level field sent replaces the stored one. Needs the API release that gives every component an id (PGA-4200); before it, a component saved without an id cannot be addressed. A template saved before that release gets its ids the next time it is saved.

## 5.1.0 — 2026-10-27

### Changed

- `create_template`, `update_template`, `copy_template` and `import_template` answer with a summary of the saved template: its id, name, tags and draft state, how many pages and components it has, and anything else the API reports next to the template, such as warnings. The whole template could run to hundreds of thousands of characters, over a chat client's tool-output limit. Set `full_response` to `true` to get it, or read it with `get_template`.

## 5.0.1 — 2026-10-23

### Fixed

- The template builder tools answered 404 on the hosted server: their address was derived from `API_BASE_URL`, whose host does not route the builder path. `BUILDER_BASE_URL` now defaults to the in-cluster service, `http://pdf-api-main/api/mcp/builder`; stdio development outside the cluster sets it explicitly.

## 5.0.0 — 2026-10-22

Version 5 is the hosted PDF Generator API MCP server at `https://mcp.pdfgeneratorapi.com/mcp`. Clients connect with OAuth: the user signs in, chooses a workspace and grants permissions, with no token to create. It is not published as a package; see [the migration guide](docs/migrating-from-4.x.md).

### Breaking

- OAuth only. The server accepts access tokens issued by the PDF Generator API authorization server for this server, and nothing else: a JWT you created yourself, sent in the `Authorization` header, is refused with a `401` that tells the client where to sign in.
- `BEARER_TOKEN_JWT` is gone. stdio mode is for local development and reads `MCP_DEV_API_TOKEN`.
- The server no longer forwards the client's token to the API. It calls the API with short-lived credentials issued for the connection's grant.
- `createMcpServer(credentials?, onToolCall?)` and `executeApiTool(toolName, definition, args, upstreamAuth?, onUpstreamStatus?)` take credentials instead of a bearer token string.

### Added

- OAuth protected resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource/mcp`, and `WWW-Authenticate` challenges that point clients to it.
- Permissions per connection: the tools a client sees follow the permissions the user granted, and a call outside them is answered with an `insufficient_scope` step-up challenge (`MCP_SCOPE_ENFORCEMENT`). The challenge names the permissions the connection already has plus the missing one, so signing in again keeps them all.
- Ended connections: when a connection was revoked or has expired, the next tool call is answered with a `401` challenge, so the client signs in again instead of reporting an error. A call already under way when the connection ended returns an error asking to send the request again.
- MCP protocol revision 2026-07-28, served without sessions, next to 2025-era clients, which keep their sessions. stdio serves both.
- Template builder tools: `get_builder_guide`, `list_builder_tools` and `run_builder_tool` let a client build and edit templates step by step with its own model, without spending the workspace's AI credits.
- Tools from the current API spec: `convert_pdf_to_image`, `store_document`, `generate_viewer_url`, `get_document_actions`, `get_document_signatures`, `get_document_versions`, `open_form_builder`, `open_form_builder_for_existing_form`, `get_template_library` and `get_template_library_item`.
- Form tools set every action: store, download, sign and send.
- The PDF Generator API icon in the server information.
- Rate limits per user (`MCP_REQUESTS_PER_MINUTE`, `MCP_INITIALIZE_PER_MINUTE`).
- `server.json`, which describes the hosted server for the official MCP Registry.

### Changed

- 2025-era sessions are bound to the user, client and organization that opened them.
- The per-request log line names the OAuth client, user, workspace and organization, and the builder tool a `run_builder_tool` call ran. It still never logs tokens or tool arguments.
- Tool fields that may be null use a single type, which more clients accept.
- The tool catalogue follows the current API spec.

### Fixed

- Binary API responses (PDFs, images) are returned intact instead of as mangled text.
- Arguments of tools whose request body is one of several shapes (`generate_document`, `open_editor`, the PDF tools and others) are validated again before the API is called.
- Form actions kept only the store action; they now keep every action and its description.

### Removed

- `smithery.yaml`. Smithery lists the hosted server from its URL.
- The JWT creation instructions from the README.

## 4.0.17

The last version that accepts a JWT you create yourself. It stays on the [`main`](https://github.com/pdfgeneratorapi/mcp-server/tree/main) branch for running your own server.
