import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { RazorpayService } from './razorpay.service';
const service = new RazorpayService(
  new ConfigService({
    app: {
      payments: { keyId: 'test-key', keySecret: 'test-secret', webhookSecret: 'webhook-secret' },
    },
  }),
);
it('verifies a signature against the stored gateway order, rejecting substitutions', () => {
  const signature = createHmac('sha256', 'test-secret').update('order_1|pay_1').digest('hex');
  expect(() => service.verifySignature('order_1', 'pay_1', signature)).not.toThrow();
  expect(() => service.verifySignature('order_2', 'pay_1', signature)).toThrow();
  expect(() => service.verifySignature('order_1', 'pay_2', signature)).toThrow();
  expect(() => service.verifySignature('order_1', 'pay_1', 'forged')).toThrow();
});
it('requires the exact signed webhook bytes', () => {
  const body = Buffer.from('{"event":"payment.captured"}');
  const signature = createHmac('sha256', 'webhook-secret').update(body).digest('hex');
  expect(() => service.verifyWebhook(body, signature)).not.toThrow();
  expect(() => service.verifyWebhook(Buffer.from(body + ' '), signature)).toThrow();
  expect(() => service.verifyWebhook(body, undefined)).toThrow();
});
it('rejects invalid money and path injection before contacting the gateway', () => {
  expect(() => service.createOrder(0, 'NN-1')).toThrow();
  expect(() => service.createOrder(1.5, 'NN-1')).toThrow();
  expect(() => service.payment('../orders')).toThrow();
});
