import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import {
  renderWorkspaceInviteEmail,
  WorkspaceInviteEmailData,
} from './templates/workspace-invite.template';

export interface SendWorkspaceInviteOptions {
  to: string;
  inviterName: string;
  workspaceName: string;
  workspaceUrl: string;
  role: string;
  token: string;
  expiresAt: Date;
}

@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private transporter?: Transporter;
  private fromEmail!: string;
  private appUrl!: string;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.initTransporter();
  }

  private initTransporter() {
    const host = this.config.get<string>('SMTP_HOST') || process.env.SMTP_HOST;
    const port = parseInt(
      this.config.get<string>('SMTP_PORT') || process.env.SMTP_PORT || '587',
      10,
    );
    const user = this.config.get<string>('SMTP_USER') || process.env.SMTP_USER;
    const pass = this.config.get<string>('SMTP_PASS') || process.env.SMTP_PASS;
    const secure =
      (this.config.get<string>('SMTP_SECURE') || process.env.SMTP_SECURE) ===
      'true';

    // 1. Resolve Frontend Client URL from environment config
    this.appUrl =
      this.config.get<string>('CLIENT_URL') ||
      this.config.get<string>('FRONTEND_URL') ||
      this.config.get<string>('APP_URL') ||
      process.env.CLIENT_URL ||
      process.env.FRONTEND_URL ||
      process.env.APP_URL ||
      'http://localhost:2915';

    // 2. Resolve From Email Address from environment config
    this.fromEmail =
      this.config.get<string>('MAIL_FROM') ||
      this.config.get<string>('SMTP_FROM') ||
      process.env.MAIL_FROM ||
      process.env.SMTP_FROM ||
      (user ? `Flux <${user}>` : 'Flux <noreply@flux.app>');

    if (host && user && pass) {
      try {
        this.transporter = nodemailer.createTransport({
          host,
          port,
          secure,
          auth: { user, pass },
        });
        this.logger.log(
          `[MailService] SMTP transporter initialized with host: ${host}:${port}`,
        );
      } catch (err: any) {
        this.logger.warn(
          `[MailService] Failed to initialize SMTP transporter: ${err.message}`,
        );
      }
    } else {
      this.logger.log(
        '[MailService] SMTP credentials not fully configured. Emails will be logged to console in dev mode.',
      );
    }
  }

  async sendWorkspaceInvite(
    options: SendWorkspaceInviteOptions,
  ): Promise<boolean> {
    const inviteUrl = `${this.appUrl.replace(/\/$/, '')}/invite/${options.token}`;
    const diffMs = options.expiresAt.getTime() - Date.now();
    const expiresInDays = Math.max(
      1,
      Math.ceil(diffMs / (1000 * 60 * 60 * 24)),
    );

    const { subject, html, text } = renderWorkspaceInviteEmail({
      inviterName: options.inviterName,
      workspaceName: options.workspaceName,
      role: options.role,
      inviteUrl,
      expiresInDays,
      recipientEmail: options.to,
    });

    if (this.transporter) {
      try {
        await this.transporter.sendMail({
          from: this.fromEmail,
          to: options.to,
          subject,
          text,
          html,
        });
        this.logger.log(`[MailService] Invitation email sent to ${options.to}`);
        return true;
      } catch (err: any) {
        this.logger.error(
          `[MailService] Failed to send email to ${options.to}: ${err.message}`,
          err.stack,
        );
        return false;
      }
    } else {
      this.logger.log(`
══════════════════════════════════════════════════════════════════════════════════
[DEV EMAIL PREVIEW] To: ${options.to}
Subject: ${subject}
Invite URL: ${inviteUrl}
Workspace: ${options.workspaceName} (${options.role})
Inviter: ${options.inviterName}
══════════════════════════════════════════════════════════════════════════════════
      `);
      return true;
    }
  }
}
