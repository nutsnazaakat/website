import {
  Body,
  Controller,
  Get,
  Headers,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  BadRequestException,
} from '@nestjs/common';
import { IsString, Matches } from 'class-validator';
import type { Request } from 'express';
import { Public } from '../../common/auth/decorators/public.decorator';
import { SkipCsrf } from '../../common/auth/decorators/skip-csrf.decorator';
import { PaymentsService } from './payments.service';

export class VerifyPaymentDto {
  @IsString() @Matches(/^pay_[a-zA-Z0-9]{1,100}$/) paymentId: string;
  @IsString() @Matches(/^[a-f0-9]{64}$/i) signature: string;
}
@Controller('checkout')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}
  @Public()
  @Get('orders/:number/receipt')
  @Header('Cache-Control', 'no-store')
  receipt(@Param('number') number: string, @Headers('x-order-token') token?: string) {
    return this.payments.receipt(number, token);
  }
  @Public()
  @Post('orders/:number/payment')
  @HttpCode(200)
  start(@Param('number') number: string, @Headers('x-order-token') token?: string) {
    return this.payments.start(number, token);
  }
  @Public()
  @Post('orders/:number/payment/verify')
  @HttpCode(200)
  verify(
    @Param('number') number: string,
    @Headers('x-order-token') token: string | undefined,
    @Body() dto: VerifyPaymentDto,
  ) {
    return this.payments.verify(number, token, dto.paymentId, dto.signature);
  }
  @Public()
  @SkipCsrf()
  @Post('webhooks/razorpay')
  @HttpCode(200)
  webhook(
    @Req() request: Request & { paymentRawBody?: Buffer },
    @Headers('x-razorpay-signature') signature?: string,
  ) {
    if (!request.paymentRawBody) throw new BadRequestException('Missing raw webhook body.');
    return this.payments.webhook(request.paymentRawBody, signature);
  }
}
