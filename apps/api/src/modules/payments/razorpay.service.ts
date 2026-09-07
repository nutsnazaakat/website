import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { equalSignature } from '../checkout/order-access';

export interface GatewayPayment {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: string;
}
@Injectable()
export class RazorpayService {
  constructor(private readonly config: ConfigService) {}
  get keyId(): string {
    return this.config.get<string>('app.payments.keyId', '');
  }
  private get secret(): string {
    return this.config.get<string>('app.payments.keySecret', '');
  }
  async request<T>(path: string, body?: unknown): Promise<T> {
    if (!this.keyId || !this.secret)
      throw new ServiceUnavailableException('Online payments are not configured.');
    let response: Response;
    try {
      response = await fetch(`https://api.razorpay.com/v1/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.secret}`).toString('base64')}`,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      throw new ServiceUnavailableException(
        'The payment provider is temporarily unavailable. Please retry this order.',
      );
    }
    if (!response.ok)
      throw new ServiceUnavailableException(
        'The payment provider could not complete this request. Please retry this order.',
      );
    return response.json() as Promise<T>;
  }
  createOrder(amount: number, receipt: string) {
    if (!Number.isSafeInteger(amount) || amount <= 0)
      throw new BadRequestException('Invalid order amount.');
    return this.request<{ id: string; amount: number; currency: string }>('orders', {
      amount,
      currency: 'INR',
      receipt,
    });
  }
  verifySignature(orderId: string, paymentId: string, signature: string): void {
    const expected = createHmac('sha256', this.secret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');
    if (!this.secret || !equalSignature(signature, expected))
      throw new BadRequestException('Payment signature could not be verified.');
  }
  verifyWebhook(body: Buffer, signature: string | undefined): void {
    const secret = this.config.get<string>('app.payments.webhookSecret', '');
    if (
      !secret ||
      !equalSignature(signature, createHmac('sha256', secret).update(body).digest('hex'))
    )
      throw new BadRequestException('Invalid webhook signature.');
  }
  payment(id: string) {
    if (!/^pay_[a-zA-Z0-9]+$/.test(id)) throw new BadRequestException('Invalid payment reference.');
    return this.request<GatewayPayment>(`payments/${id}`);
  }
}
