import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * `POST /admin/reviews/:id/reject`'s body.
 *
 * **The reason is optional**, and that is a judgment call worth stating. `reviews.rejectionReason`
 * is a nullable `varchar(200)` and nothing reads it today — no notification is sent to the author,
 * and a rejected review is invisible to everyone. Requiring one would be inventing a workflow the
 * schema does not have: the honest position is that it is a note to the next moderator, so it is
 * offered and not demanded. The column's length is the cap.
 *
 * `POST /admin/reviews/:id/approve` takes no body at all, and needs none — there is nothing to say
 * about an approval that the audit row does not already carry.
 */
export class RejectReviewDto {
  /** A note for the next moderator, not a message to the author. Nothing sends it anywhere. */
  @ApiPropertyOptional({ example: 'Names a competitor and gives no detail about the product.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  reason?: string;
}
