import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Standard security headers. CSP off: this is a JSON API, not a website.
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

  // Only the K-Lipwa frontends may call this API from a browser. Server-to-
  // server calls (webhooks, curl) have no Origin header and are unaffected.
  const allowedOrigins = [
    'https://klipwa.netlify.app',
    'https://klipwa.app',
    'https://www.klipwa.app',
  ];
  app.enableCors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // non-browser clients
      if (
        allowedOrigins.includes(origin) ||
        /^http:\/\/localhost(:\d+)?$/.test(origin) || // local dev
        /^https:\/\/[a-z0-9-]+--klipwa\.netlify\.app$/.test(origin) // deploy previews
      ) {
        return cb(null, true);
      }
      return cb(null, false);
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const port = process.env.PORT ?? 4000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`K-Lipa API on http://localhost:${port}`);
}
bootstrap();
