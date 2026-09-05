import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'b2c@demo.in' })
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(255)
  email: string;

  /**
   * Only a length bound here. Strength rules belong to registration; applying them at login
   * would tell an attacker which candidate passwords are even worth trying.
   */
  @ApiProperty({ example: 'Password123!' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password: string;
}
