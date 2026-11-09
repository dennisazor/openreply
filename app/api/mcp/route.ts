import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateApiToken } from "@/lib/api-tokens";
import { createWorkspaceMcpServer } from "@/lib/mcp/server";

export const runtime = "nodejs";

/**
 * Claude connector (MCP over Streamable HTTP), stateless: each request gets a
 * fresh server bound to the token's workspace, which suits serverless.
 *
 *   claude mcp add --transport http openreply https://<your-app>/api/mcp \
 *     --header "Authorization: Bearer orp_..."
 */
async function handle(request: Request): Promise<Response> {
  const auth = await authenticateApiToken(request.headers.get("authorization"));
  if (!auth) {
    return Response.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message:
            "Missing or invalid API token. Create one in OpenReply under Settings, Claude connector.",
        },
        id: null,
      },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
    );
  }

  const server = createWorkspaceMcpServer(auth.workspaceId);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

export { handle as GET, handle as POST, handle as DELETE };
