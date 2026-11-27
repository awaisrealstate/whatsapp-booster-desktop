export interface EmailDeliveryResult {
  delivered: boolean;
  reason?: string;
}

export interface EmailSender {
  sendVerificationEmail(params: {
    to: string;
    name: string;
    verificationToken: string;
    expiresAt: number;
  }): Promise<EmailDeliveryResult>;

  sendPasswordResetEmail(params: {
    to: string;
    name: string;
    resetToken: string;
    expiresAt: number;
  }): Promise<EmailDeliveryResult>;
}

/**
 * Honest default adapter when no external email delivery service is configured.
 * Never claims emails were sent when no provider exists.
 */
export class UnconfiguredEmailSender implements EmailSender {
  async sendVerificationEmail(): Promise<EmailDeliveryResult> {
    return {
      delivered: false,
      reason: 'EMAIL_PROVIDER_NOT_CONFIGURED'
    };
  }

  async sendPasswordResetEmail(): Promise<EmailDeliveryResult> {
    return {
      delivered: false,
      reason: 'EMAIL_PROVIDER_NOT_CONFIGURED'
    };
  }
}
