'use client'

import { QRCodeSVG } from 'qrcode.react'

interface KhqrCardProps {
  /** Merchant / receiver name */
  merchant: string
  /** Amount in main currency (e.g. USD) */
  amount: string
  /** Currency code to display (USD, KHR, etc.) */
  currency: string
  /** The QR payload */
  qrValue: string
  /** QR code size in px */
  qrSize?: number
  /** Optional receiver account number to show below the QR */
  accountNumber?: string
  /** Optional bank name (defaults to "ABA BANK") */
  bankName?: string
  onCancel?: () => void
  onRetry?: () => void
  status?: 'pending' | 'paid' | 'failed'
}

export default function KhqrCard({
  merchant,
  amount,
  currency,
  qrValue,
  qrSize = 200,
  accountNumber,
  bankName = 'ABA BANK',
  onCancel,
  onRetry,
  status = 'pending',
}: KhqrCardProps) {
  return (
    <div style={{ maxWidth: 380, margin: '0 auto' }}>
      {/* Top dark header bar */}
      <div
        style={{
          background: '#0a5c6e',
          padding: '16px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderTopLeftRadius: 12,
          borderTopRightRadius: 12,
        }}
      >
        <span
          style={{
            fontFamily: 'Inter, sans-serif',
            fontWeight: 700,
            fontSize: '0.9rem',
            letterSpacing: '0.08em',
            color: '#ffffff',
            textTransform: 'uppercase',
          }}
        >
          {bankName}
        </span>
        <span
          style={{
            fontFamily: 'Inter, sans-serif',
            fontSize: '0.75rem',
            color: 'rgba(255,255,255,0.7)',
          }}
        >
          KHQR Payment
        </span>
      </div>

      {/* Red label */}
      <div
        style={{
          background: '#e31c25',
          padding: '10px 20px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span
          style={{
            fontFamily: 'Orbitron, sans-serif',
            fontWeight: 700,
            fontSize: '0.95rem',
            color: '#ffffff',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}
        >
          KHQR
        </span>
      </div>

      {/* White card body */}
      <div
        style={{
          background: '#ffffff',
          padding: '28px 24px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }}
      >
        {/* Merchant name */}
        <div
          style={{
            fontFamily: 'Inter, sans-serif',
            fontSize: '1rem',
            fontWeight: 600,
            color: '#1a1a2e',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            marginBottom: 20,
          }}
        >
          {merchant}
        </div>

        {/* Dashed line */}
        <div
          style={{
            width: '100%',
            borderBottom: '1px dashed #c0c0c0',
            marginBottom: 20,
          }}
        />

        {/* QR Code */}
        <div
          style={{
            padding: '16px',
            background: '#ffffff',
            border: '1px solid #e5e5e5',
            borderRadius: 8,
            marginBottom: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <QRCodeSVG value={qrValue} size={qrSize} />
        </div>

        {/* Dashed line */}
        <div
          style={{
            width: '100%',
            borderBottom: '1px dashed #c0c0c0',
            marginBottom: 20,
          }}
        />

        {/* Amount */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontFamily: 'DM Mono, monospace',
            fontSize: '1.1rem',
            fontWeight: 500,
            color: '#1a1a2e',
          }}
        >
          <span style={{ fontSize: '0.85rem' }}>$</span>
          <span>{amount}</span>
          <span style={{ fontSize: '0.85rem' }}>{currency}</span>
        </div>

        {/* Account number */}
        {accountNumber && (
          <div
            style={{
              marginTop: 12,
              fontFamily: 'DM Mono, monospace',
              fontSize: '0.82rem',
              color: '#555',
            }}
          >
            Account: {accountNumber}
          </div>
        )}

        {/* Status / actions */}
        <div style={{ marginTop: 22, width: '100%' }}>
          {status === 'pending' && (
            <>
              <p
                style={{
                  textAlign: 'center',
                  fontSize: '0.85rem',
                  color: '#888',
                  marginBottom: 14,
                }}
              >
                Waiting for payment confirmation...
              </p>
              {onCancel && (
                <button
                  onClick={onCancel}
                  style={{
                    width: '100%',
                    padding: '10px',
                    border: '1px solid #ddd',
                    borderRadius: 6,
                    background: '#f8f8f8',
                    color: '#555',
                    fontSize: '0.85rem',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = '#eee'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = '#f8f8f8'
                  }}
                >
                  Cancel
                </button>
              )}
            </>
          )}

          {status === 'paid' && (
            <div style={{ textAlign: 'center' }}>
              <div
                style={{
                  fontSize: '1.2rem',
                  fontWeight: 700,
                  color: '#27c93f',
                  marginBottom: 8,
                }}
              >
                Payment Confirmed
              </div>
              <p style={{ fontSize: '0.85rem', color: '#666', marginBottom: 14 }}>
                Thank you for your payment.
              </p>
              {onRetry && (
                <button
                  onClick={onRetry}
                  style={{
                    padding: '10px 24px',
                    border: 'none',
                    borderRadius: 6,
                    background: '#27c93f',
                    color: '#fff',
                    fontSize: '0.9rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Done
                </button>
              )}
            </div>
          )}

          {status === 'failed' && (
            <div style={{ textAlign: 'center' }}>
              <div
                style={{
                  fontSize: '1.1rem',
                  fontWeight: 600,
                  color: '#e31c25',
                  marginBottom: 8,
                }}
              >
                Payment Failed
              </div>
              <p style={{ fontSize: '0.85rem', color: '#666', marginBottom: 14 }}>
                Something went wrong. Please try again.
              </p>
              {onRetry && (
                <button
                  onClick={onRetry}
                  style={{
                    padding: '10px 24px',
                    border: 'none',
                    borderRadius: 6,
                    background: '#e31c25',
                    color: '#fff',
                    fontSize: '0.9rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Try Again
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Bottom dark footer */}
      <div
        style={{
          background: '#0a5c6e',
          padding: '12px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          borderBottomLeftRadius: 12,
          borderBottomRightRadius: 12,
        }}
      >
        <span
          style={{
            fontFamily: 'Inter, sans-serif',
            fontWeight: 700,
            fontSize: '0.8rem',
            letterSpacing: '0.1em',
            color: '#ffffff',
            textTransform: 'uppercase',
          }}
        >
          {bankName}
        </span>
        <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.75rem' }}>
          SECURE PAYMENT
        </span>
      </div>
    </div>
  )
}
