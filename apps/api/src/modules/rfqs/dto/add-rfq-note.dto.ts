import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * `POST /admin/rfqs/:rfqNumber/notes` — brief §34's *"Allow internal notes"*.
 *
 * One field, and no `authorUserId`: the author comes from the signed token and from nowhere else,
 * assigned **after** the DTO spread in the controller so no body field can override who wrote a
 * note. The global pipe's `whitelist` would strip an unknown property anyway; the spread order is
 * what makes that a property of this code rather than of the pipe's configuration.
 *
 * `rfq_notes.body` is `text`, so nothing at the database level bounds this. `@MaxLength(4000)` is
 * generous for a sales note and finite, matching `CreateRfqDto.notes`' own reason for bounding a
 * `text` column at the request. `@MinLength(1)` after trimming is not expressible here, so the
 * service trims and refuses a blank — an empty note is a row with no content that still appears in
 * the history as though something was said.
 */
export class AddRfqNoteDto {
  @ApiProperty({ example: 'Rang the buyer; wants 200kg a month from October.' })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body: string;
}
