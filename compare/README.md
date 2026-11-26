# ELIZA & Modern AI

The comparison page sends the same message to the existing ELIZA engine and a modern chatbot. Both conversations retain their own history. **New conversation** clears both and cancels an outstanding model request.

ELIZA cycles through the replies associated with each matching rule. It does not randomly select a reply. This matches the reply-selection mechanism described on page 40 of [Weizenbaum's 1966 paper](https://courses.cs.umbc.edu/undergraduate/CMSC471/papers/weizenbaum.eliza.1966.pdf#page=5); other existing classroom adaptations are retained.

## Personal demo: no Node setup required

Open `eliza/index.html` in your browser, select **Compare**, and expand **API settings**.

1. Enter your API key. The form starts with DeepSeek's `deepseek-flash` model.
2. If needed, change the model ID and expand **API options** to change the base URL or request format. The default is `https://api.deepseek.com` with Chat Completions. Other providers can use their own model ID and endpoint; select Responses API for OpenAI Responses.
3. Select **Use this API**, then send a message.

The key lives only in this tab's JavaScript memory. The password field is cleared after applying it. **Clear key**, refreshing, or leaving the page clears it; the application does not save it in files, URLs, cookies, localStorage, or sessionStorage. Applying settings itself does not make a model request. Changing API settings starts a new comparison conversation.

This is a temporary personal-demo mode. Anyone with access to the browser or injected browser scripts may still inspect a browser-held credential. Use a dedicated, limited key on a trusted browser. The provider must allow browser requests (CORS); an unsupported browser connection cannot be fixed by hiding the key in frontend code. See the [official browser-runtime guidance](https://developers.openai.com/api/reference/typescript#requirements).

`compare/index.html` remains a compatibility link to the Compare tab at `eliza/index.html#compare`.

## Shared classroom system prompt

Edit **system-prompt.js** to change the instruction for every modern model. Both the browser adapter and optional Node backend use this same text on every request: Chat Completions receives a `system` message before the conversation; Responses receives it as `instructions`. The prompt describes the secondary-school comparison, concise replies in the student's language, honest limitations, and classroom-appropriate conversation. It does not ask the model to imitate ELIZA or promote one chatbot over the other.

This instruction is public and contains no credentials. It guides model behavior but cannot guarantee perfect adherence. A separately supplied backend must apply this prompt itself; the frontend cannot enforce the behavior of an arbitrary external service.

DeepSeek's Chat Completions requests use `max_tokens` and disable thinking mode for quick classroom replies. Provider-specific parameters stay outside the shared prompt. See [DeepSeek's quickstart](https://api-docs.deepseek.com/) and [Chat Completions reference](https://api-docs.deepseek.com/api/create-chat-completion/).

## Optional backend mode

For a shared deployment where the teacher's key stays on the server, the original backend interface remains available. Use Node.js 22 or newer. From the LessonDemos folder:

```sh
node compare/server.mjs
```

Open [http://127.0.0.1:8787/eliza/index.html#compare](http://127.0.0.1:8787/eliza/index.html#compare). When the backend is configured, the page can use it without entering a key in the browser.

## Configure the optional backend

```sh
cp compare/.env.example compare/.env
```

In **compare/.env**, fill in:

```dotenv
MODERN_API_KEY=your-secret-key
MODERN_MODEL=your-model-id
MODERN_BASE_URL=https://api.openai.com/v1
MODERN_API_FORMAT=responses
```

Restart the server. The browser calls `/api/chat`; only the server sends your key to the model provider. The repository includes an empty `.env.example`. Local `.env` files are ignored by Git, and the static file server blocks dotfiles and backend source files.

`responses` uses the OpenAI Responses request format. `chat-completions` uses `/chat/completions` with `max_completion_tokens`, except for `api.deepseek.com`, which uses `max_tokens` and `thinking: {"type":"disabled"}`. If another provider needs different parameters, update both adapters in `api.js` and `server.mjs` while keeping the shared system prompt.

## Interface left for a different backend

Change the public URLs in **config.js**. These must point to your backend, which keeps the secret key. For a backend on another origin, it must allow requests from the page's origin through CORS.

```http
POST /api/chat
Content-Type: application/json

{"messages":[{"role":"user","content":"I feel happy."}]}
```

Successful response:

```json
{"reply":"That's lovely! What made you feel happy?","model":"your-model-id"}
```

Connection status:

```http
GET /api/status
```

```json
{"configured":true,"model":"your-model-id"}
```

The example reply above documents the interface; the page does not substitute it for a model response. If your API returns another schema, change `callModernAPI` in **server.mjs** or normalize it to `{reply, model}` in your own backend.

## Public repository and hosting

The supplied server binds only to `127.0.0.1` for local classroom demonstrations. A public GitHub repository or GitHub Pages can host the frontend, but does not run this Node backend. For shared online use, host the backend separately with access control and usage limits so visitors cannot freely spend your API balance.

Official reference: [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create).

## Checks

```sh
node --test compare/comparison.test.mjs
```

The tests use an injected local mock provider; they do not make paid model requests.
