/**
 * What the server tells a client, in its instructions, prompts and tool descriptions, names the
 * operations to run and the tools that run them. A renamed operation or tool must not leave the
 * guidance pointing at one that no longer exists.
 */
import { describe, it, expect, jest } from '@jest/globals';

jest.unstable_mockModule('axios', () => ({
  default: Object.assign(jest.fn(), { isAxiosError: () => false }),
  __esModule: true,
}));

const { createMcpServer } = await import('../server.js');
const { createStaticCredentials } = await import('../credentials/upstream.js');
const { operations } = await import('../operations.js');
const { metaTools } = await import('../metaTools.js');
const { Client } = await import('@modelcontextprotocol/client');
const { InMemoryTransport } = await import('@modelcontextprotocol/server');

async function connectedClient() {
  const server = createMcpServer(createStaticCredentials('upstream-token'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return client;
}

/** Every snake_case name a text mentions that is neither an operation nor a meta-tool. */
function unknownNames(text: string): string[] {
  return [...new Set(text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [])]
    .filter(name => !operations.has(name) && !metaTools.has(name));
}

async function promptText(name: string, args: Record<string, string>) {
  const { messages } = await (await connectedClient()).getPrompt({ name, arguments: args });

  return messages.map(message => (message.content as { text: string }).text).join('\n');
}

describe('the server instructions', () => {
  it('name only operations and tools that exist', async () => {
    const instructions = (await connectedClient()).getInstructions() ?? '';

    expect(instructions).not.toBe('');
    expect(unknownNames(instructions)).toEqual([]);
  });

  it('tell the client how to find, describe and run operations', async () => {
    const instructions = (await connectedClient()).getInstructions() ?? '';

    for (const tool of metaTools.keys()) {
      expect(instructions).toContain(tool);
    }
  });

  it('ask for a link only when the user wants one', async () => {
    const instructions = (await connectedClient()).getInstructions() ?? '';

    expect(instructions).toContain('Ask for a document as a link (output url or viewer) only when the user wants a link: a link stores the document for 30 days.');
  });

  it('say how lists are paged and to run calls one after another', async () => {
    const instructions = (await connectedClient()).getInstructions() ?? '';

    expect(instructions).toContain('A list returns at most 10 records a page: narrow it with its search and filters rather than reading every page. Run calls one after another, not at the same time: the API takes 2 requests a second, and a template takes one builder step at a time.');
  });
});

describe('the meta-tool descriptions', () => {
  it.each([...metaTools.values()].map(tool => [tool.name, tool.description]))('of %s name only operations and tools that exist', (_name, description) => {
    expect(unknownNames(description)).toEqual([]);
  });
});

describe('the prompts', () => {
  it.each([
    ['generate-pdf', { templateId: '42' }],
    ['convert-to-pdf', { source: 'https://example.com' }],
    ['convert-to-pdf', { source: '<p>Hello</p>' }],
    ['create-einvoice', { format: 'UBL' }],
    ['create-einvoice', { format: 'XRechnung' }],
    ['create-einvoice', { format: 'Factur-X' }],
  ])('%s %j names only operations and tools that exist, and runs them with the meta-tools', async (name, args) => {
    const text = await promptText(name, args);

    expect(unknownNames(text)).toEqual([]);
    expect(text).toMatch(/read_operation|call_operation/);
  });

  it.each([
    ['create-einvoice', { format: 'UBL' }, 'create_einvoice'],
    ['create-einvoice', { format: 'XRechnung' }, 'create_xrechnung_einvoice'],
    ['create-einvoice', { format: 'Factur-X' }, 'create_facturx_einvoice'],
    ['convert-to-pdf', { source: 'https://example.com' }, 'convert_url_to_pdf'],
    ['convert-to-pdf', { source: '<p>Hello</p>' }, 'convert_html_to_pdf'],
  ])('%s %j runs %s with call_operation', async (name, args, operation) => {
    expect(await promptText(name, args)).toContain(`run ${operation} with call_operation`);
  });

  /** A whole document in the chat can be far larger than a client takes; a preview is a few images. */
  it('previews the filled template, and generates the document only when the user asks for it', async () => {
    const text = await promptText('generate-pdf', { templateId: '42' });

    expect(text).toBe('Generate a PDF document using template ID 42. First run get_template_data with read_operation and templateId 42 to see the data fields the template uses. Then show the template filled with data for those fields: run preview_template with read_operation, which shows up to 3 pages as images, free and stored nowhere. Run generate_document with call_operation only when I want the document itself, with the output I ask for. describe_operation shows the arguments of each.');
  });

  it('generates the document after the preview, with the output the user names', async () => {
    const text = await promptText('generate-pdf', { templateId: '42', outputFormat: 'url' });

    expect(text).toContain('run preview_template with read_operation');
    expect(text).toContain('Then run generate_document with call_operation, with the template ID, the same data and output "url".');
  });
});
