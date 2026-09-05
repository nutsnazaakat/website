import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import { Public } from '../../common/auth/decorators/public.decorator';

interface HealthReport {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  database: 'up' | 'down';
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Process and database liveness' })
  async check(@Res({ passthrough: true }) response: Response): Promise<HealthReport> {
    let database: 'up' | 'down' = 'down';
    try {
      await this.dataSource.query('SELECT 1');
      database = 'up';
    } catch {
      // Reported as degraded rather than thrown: a monitor needs the body, not a 500.
    }

    // 503 when the database is unreachable, so an orchestrator actually pulls the instance out
    // of rotation. A status-code-blind 200 with `degraded` in the body is the most common way a
    // health check ends up decorative — the default probe in Docker, k8s and most load balancers
    // keys off the code alone. `passthrough` keeps the body flowing through the success envelope.
    if (database === 'down') response.status(HttpStatus.SERVICE_UNAVAILABLE);

    return {
      status: database === 'up' ? 'ok' : 'degraded',
      uptimeSeconds: Math.floor(process.uptime()),
      database,
    };
  }
}
