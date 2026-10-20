import qrcode from 'qrcode-generator';

/** Generated locally: no download URL (or bearer token) goes to a QR service. */
export function androidQrSvg(url: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(url, 'Byte');
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
}
