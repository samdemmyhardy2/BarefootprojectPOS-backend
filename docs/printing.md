# Receipt printing and LAN discovery

Printing stays on the NestJS server. The browser never opens port 9100. A saved printer is used for every receipt after setup. Discovery is only for finding the printer and for troubleshooting.

## What the server scans

The scan looks at the server's own private IPv4 interface. It does not assume `192.168.1.0/24`. An administrator can pass another private subnet, from `/30` through `/22` (at most 1024 hosts). Public addresses are rejected.

Methods, used together unless the request limits them:

- **ARP.** `arp-scan` when it is installed. Otherwise a ping sweep and the kernel neighbour table (`/proc/net/arp`). This finds IP and MAC addresses.
- **mDNS.** A query to `224.0.0.251` for `_ipp._tcp`, `_ipps._tcp`, `_printer._tcp`, and `_pdl-datastream._tcp`.
- **SNMP.** A single public-community GET of the standard system and printer MIB objects, sent only to hosts already seen on the LAN.
- **TCP.** Short connections to ports 9100 (RAW), 631 (IPP), 515 (LPR), 80, and 443. An open port 9100 is evidence, not proof, that the device is a printer.

An open port or a vendor name is not enough to invent a model. If the name or SNMP text does not contain a model such as `TM-m30III`, the device stays an unknown printer candidate.

## Linux packages

Optional, for a fuller ARP scan:

```bash
sudo apt install arp-scan
```

`arp-scan` needs permission to send ARP. On a server that is not run as root, either run the scan with `CAP_NET_RAW` or rely on the ping and neighbour-table fallback. SNMP, mDNS, and TCP checks use normal sockets and need no extra packages.

The receipt image and ESC/POS bytes are built in Node. No browser package is required.

## DHCP reservation

The server never changes a printer's IP address and never edits the router. After you select the Epson, reserve that IP on the router using the printer's MAC address. The reservation is what keeps `192.168.1.15` (or whichever address you found) after the printer power-cycles. The saved row in PostgreSQL is not deleted or rewritten when a later scan does not see the printer.

## Environment

```env
PRINTER_HOST=192.168.1.15
PRINTER_PORT=9100
PRINT_CONNECT_TIMEOUT_MS=3000
PRINT_DRY_RUN=false
```

`PRINTER_HOST` is used only when the printer table is empty, to create the first saved printer. It does not overwrite a printer you already saved. `PRINT_DRY_RUN=true` renders the PNG and ESC/POS payload and does not open a socket.

## API

All routes require a logged-in user. Scanning and printer setup require an administrator. Receipt preview and printing are available to signed-in staff. Printing accepts a saved printer id, never an address from the browser.

```http
POST /network/discovery/scan
GET  /network/discovery/results
GET  /network/discovery/printers
GET  /network/discovery/devices/:ip

GET    /printing/status
GET    /printing/printers
POST   /printing/printers
PATCH  /printing/printers/:id
DELETE /printing/printers/:id
PATCH  /printing/printers/:id/default
POST   /printing/printers/:id/test-connection
POST   /printing/printers/:id/test-print

GET  /printing/receipts/:orderId/preview
POST /printing/receipts/:orderId
GET  /printing/jobs/:jobId
POST /printing/jobs/:jobId/retry
```

`POST /printing/receipts/:orderId` reads the order, prices, and totals from PostgreSQL. Send `clientRequestId` (a UUID) so a double click returns the same job and does not print twice. A failed job can be retried. A completed job is not sent again; create a new request only when a reprint is intended.

`test-connection` only opens TCP. `sent: true` on a print means the printer accepted the bytes. It does not prove paper came out.

## How to print

1. Open **Printers** as an administrator and choose **Scan network**.
2. Filter to printers and select the Epson TM-m30III.
3. Save it. The first saved printer becomes the default.
4. **Test connection**, then **Test print**.
5. On a paid order, open the receipt and choose **Print to printer**. The preview image is the same raster that is sent to the printer.

Set a DHCP reservation for the printer MAC before relying on the address overnight.
