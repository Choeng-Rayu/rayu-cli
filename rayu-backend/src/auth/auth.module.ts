import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { JwtModule } from '@nestjs/jwt'
import { PlansModule } from '../plans/plans.module'
import { UsersModule } from '../users/users.module'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { ClerkService } from './clerk.service'
import { CodeStoreService } from './code-store.service'
import { RayuAuthGuard } from './rayu-auth.guard'
import { RolesGuard } from './roles.guard'

@Module({
  imports: [
    UsersModule,
    PlansModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('app.jwtSecret'),
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    ClerkService,
    { provide: CodeStoreService, useFactory: () => new CodeStoreService() },
    RayuAuthGuard,
    RolesGuard,
  ],
  exports: [AuthService, RayuAuthGuard, RolesGuard],
})
export class AuthModule {}
