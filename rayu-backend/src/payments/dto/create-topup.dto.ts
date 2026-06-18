import { IsInt, Min } from 'class-validator'

export class CreateTopupDto {
  @IsInt()
  @Min(1000)
  credits!: number
}
