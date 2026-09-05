import { Body, Controller, Post } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsString, MinLength, ValidateNested, ValidationError } from 'class-validator';
import { validationExceptionFactory } from '../../src/app.module';
import { Public } from '../../src/common/auth/decorators/public.decorator';
import { SkipCsrf } from '../../src/common/auth/decorators/skip-csrf.decorator';
import { expectError, expectSuccess, request, useIntegrationApp } from './helpers';

class ProbeQuantityDto {
  @IsInt()
  quantity: number;
}

class ProbeDto {
  @IsString()
  @MinLength(3)
  name: string;

  @ValidateNested()
  @Type(() => ProbeQuantityDto)
  nested: ProbeQuantityDto;
}

/**
 * A body-accepting route exists nowhere in `src/` yet — the service is one `GET /health` — so the
 * request pipeline is exercised through this probe, registered beside `AppModule` in the testing
 * module. Global enhancers apply to it exactly as they do to a real controller, which is the point:
 * every assertion below passes only if `AppModule` alone configured the pipeline.
 */
@Controller('validation-probe')
class ValidationProbeController {
  /**
   * `@Public()` exempts the probe from the global `JwtAuthGuard`, `@SkipCsrf()` from the global
   * `CsrfGuard`. Both are now required, and the second one arrived as a surprise: an earlier
   * version of this comment anticipated only the 401, so registering `CsrfGuard` globally turned
   * three of the four tests below into `403 Forbidden`.
   *
   * The reason is worth keeping. `CsrfGuard` demands a `nn_csrf` cookie matching an
   * `X-CSRF-Token` header, and that cookie was for a long time issued only by login, register and
   * refresh — so **every anonymous state-changing request was refused**, this probe included.
   * `CsrfBootstrapMiddleware` now issues it to anonymous callers as well, so that the guest cart can
   * be written to at all, but note that it does not rescue this test: plain `request()` keeps no
   * cookie jar, so there would still be no header to echo.
   *
   * Skipping is right here rather than staging a cookie-and-header pair, because this file tests
   * the *validation pipeline*. CSRF has its own unit spec and its own assertions in the auth
   * integration suite; adding CSRF ceremony to every unrelated POST would obscure what each
   * test is actually claiming.
   */
  @Public()
  @SkipCsrf()
  @Post()
  echo(@Body() dto: ProbeDto): ProbeDto {
    return dto;
  }
}

describe('request pipeline configured by AppModule', () => {
  const integration = useIntegrationApp({ controllers: [ValidationProbeController] });

  it('parses a JSON body and lets a valid payload through', async () => {
    const response = await request(integration.app)
      .post('/api/v1/validation-probe')
      .send({ name: 'cashew', nested: { quantity: 3 } })
      .expect(201);

    expect(expectSuccess<ProbeDto>(response)).toEqual({ name: 'cashew', nested: { quantity: 3 } });
  });

  it('rejects an invalid payload with details keyed by field path', async () => {
    const response = await request(integration.app)
      .post('/api/v1/validation-probe')
      .send({ name: 'no', nested: { quantity: 'three' }, surprise: 'mass assignment' })
      .expect(400);

    const body = expectError(response);

    expect(body).toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_FAILED',
      message: 'Validation failed',
    });
    // The whole reason `exceptionFactory` exists: per-field buckets, nested reached by dotted
    // path, and never a single flat `_errors` list.
    expect(Object.keys(body.details ?? {}).sort()).toEqual(['name', 'nested.quantity', 'surprise']);
    expect(body.details?.['name']?.[0]).toContain('longer than or equal to 3');
    // `forbidNonWhitelisted`, i.e. the mass-assignment defence, reported as its own field.
    expect(body.details?.['surprise']?.[0]).toContain('should not exist');
  });

  it('accepts a body far larger than the platform default parser limit', async () => {
    // 200 kB: over body-parser's 100 kB default, under the configured 1 MB. It passes only if the
    // parser doing the reading is the one `AppModule` installed — if platform-express ever gets to
    // register its own first, this is a 413.
    const response = await request(integration.app)
      .post('/api/v1/validation-probe')
      .send({ name: 'n'.repeat(200_000), nested: { quantity: 1 } })
      .expect(201);

    expect(expectSuccess<ProbeDto>(response).name).toHaveLength(200_000);
  });

  it('rejects a body over the 1 MB limit as 413, inside the error envelope', async () => {
    const response = await request(integration.app)
      .post('/api/v1/validation-probe')
      .send({ name: 'n'.repeat(1_200_000), nested: { quantity: 1 } })
      .expect(413);

    // 413 and not 500: body-parser's own error carries a status that only survives because the
    // parsers are wrapped when they are mounted as module middleware. See `preservingStatus`.
    const body = expectError(response);
    expect(body.statusCode).toBe(413);
    // And it is attributable: request tracking is mounted ahead of the parsers precisely so a
    // rejected upload is not logged and returned as `requestId: "unknown"`.
    expect(body.requestId).not.toBe('unknown');
    expect(response.get('X-Request-Id')).toBe(body.requestId);
  });

  it('rejects malformed JSON as 400, inside the error envelope', async () => {
    const response = await request(integration.app)
      .post('/api/v1/validation-probe')
      .set('Content-Type', 'application/json')
      .send('{"name":')
      .expect(400);

    expect(expectError(response).statusCode).toBe(400);
  });

  /**
   * `CsrfBootstrapMiddleware` is in the chain, and this is the only thing that says so.
   *
   * Measured before adding it: removing the middleware from `AppModule.configure()` entirely left
   * all 253 unit tests and all 105 integration tests green. The guest cart is the reason the
   * middleware exists — without it every anonymous `PUT /cart` answers 403 `CSRF_TOKEN_INVALID` —
   * so "is it actually registered" should not be the one fact nothing checks. The cart's own four
   * bootstrap cases belong to the cart integration spec; this one belongs here, because being in
   * *this* pipeline is what is being asserted.
   *
   * Asserted on the **first** request a brand-new client makes, having fetched nothing beforehand,
   * and on a route that issues no session — so `CookieService.issue()` cannot be what set it.
   */
  it('hands a brand-new client an nn_csrf cookie on its very first request', async () => {
    const response = await request(integration.app).get('/api/v1/health').expect(200);

    const entry = (response.get('Set-Cookie') ?? []).find((header) =>
      header.startsWith('nn_csrf='),
    );

    expect(entry).toBeDefined();
    // Readable by JavaScript on purpose: the client has to echo it in `X-CSRF-Token`, which is the
    // whole of the double-submit. `HttpOnly` here would leave every guest write refused.
    expect(entry).not.toMatch(/HttpOnly/i);
  });
});

describe('validationExceptionFactory', () => {
  it('still records a field whose error has neither constraints nor children', () => {
    // A custom or group-scoped validator can produce such a node. It cannot be provoked through
    // HTTP with the validators this service uses today, so it is asserted directly — the
    // alternative is a documented guarantee with an untested hole in it.
    const orphan = new ValidationError();
    orphan.property = 'settlementWindow';

    const failure = validationExceptionFactory([orphan]);

    expect(failure.code).toBe('VALIDATION_FAILED');
    expect(failure.getStatus()).toBe(400);
    expect(failure.details).toEqual({ settlementWindow: ['Invalid value'] });
  });

  it('keeps a parent with children out of details and reports the children by dotted path', () => {
    const child = new ValidationError();
    child.property = 'quantity';
    child.constraints = { isInt: 'quantity must be an integer number' };

    const parent = new ValidationError();
    parent.property = 'nested';
    parent.children = [child];

    expect(validationExceptionFactory([parent]).details).toEqual({
      'nested.quantity': ['quantity must be an integer number'],
    });
  });
});
