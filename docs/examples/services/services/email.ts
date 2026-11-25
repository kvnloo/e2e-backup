import { once } from 'node:events';
import { createServer } from 'node:http';
import { text } from 'node:stream/consumers';
import { defineService } from 'e2e';

type Email = {
  to: string;
  subject: string;
};

export const email = defineService({
  async *start({ signal }) {
    const emails: Email[] = [];

    const server = createServer(async (request, response) => {
      emails.push(JSON.parse(await text(request)));
      response.end();
    });

    server.listen({ port: 0, host: '127.0.0.1', signal });

    await once(server, 'listening', { signal });

    const address = server.address();

    if (address === null || typeof address === 'string') {
      throw new Error('The email server has no TCP address.');
    }

    yield {
      url: `http://127.0.0.1:${address.port}`,
      sent: () => emails,
    };

    server.close();

    await once(server, 'close');
  },
});
