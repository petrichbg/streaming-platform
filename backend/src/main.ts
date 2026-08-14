import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // The web client is served from a different origin (its own dev server, or
  // another host on the LAN), so the browser blocks API calls without this.
  // Origins are listed explicitly rather than using "*" because every request
  // carries an Authorization header.
  app.enableCors({
    origin: (process.env.WEB_ORIGIN ?? 'http://localhost:3001')
      .split(',')
      .map((o) => o.trim()),
    credentials: true,
  });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Backend listening on port ${port}`);
}

bootstrap();
