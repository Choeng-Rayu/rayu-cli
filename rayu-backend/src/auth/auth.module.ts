import { forwardRef, Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { JwtModule } from '@nestjs/jwt'
import { ModelsModule } from '../models/models.module'
import { OrganizationsModule } from '../organizations/organizations.module'
import { PlansModule } from '../plans/plans.module'
import { AppSettingsModule } from '../settings/app-settings.module'
import { UsersModule } from '../users/users.module'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { OAuthService } from './oauth.service'
import { CodeStoreService } from './code-store.service'
import { RayuAuthGuard } from './rayu-auth.guard'
import { RolesGuard } from './roles.guard'

@Module({
  imports: [
    UsersModule,
    PlansModule,
    ModelsModule,
    AppSettingsModule,
    // Two-way by nature: sign-in writes team membership (SSO auto-join) and
    // reads it back into the JWT, while the team endpoints authenticate with
    // this module's guard.
    forwardRef(() => OrganizationsModule),
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
    OAuthService,
    { provide: CodeStoreService, useFactory: () => new CodeStoreService() },
    RayuAuthGuard,
    RolesGuard,
  ],
  exports: [AuthService, RayuAuthGuard, RolesGuard],
})
export class AuthModule {}
