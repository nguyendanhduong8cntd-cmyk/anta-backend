import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
const str = (format?: string): SchemaObject => ({ type: 'string', ...(format ? { format } : {}) });
const int: SchemaObject = { type: 'integer' };
const bool: SchemaObject = { type: 'boolean' };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const array = (name: string): SchemaObject => ({ type: 'array', items: ref(name) });
const object = (properties: Record<string, any>, required = Object.keys(properties)): SchemaObject => ({ type: 'object', properties, required });
const page = (name: string) => object({ items: array(name), page: int, pageSize: int, total: int });
export function buildOpenApi(app: INestApplication) {
  const doc = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Alobo Clone API').setVersion('0.1.0')
    .setDescription('Clone backend contract, not original Alobo API. Paid flows are sandbox/fail-closed until merchant integration.').addBearerAuth().build());
  const uuid = str('uuid'), time = str('date-time');
  const schemas: Record<string, SchemaObject> = {
    ApiError: object({ data: { nullable: true, type: 'object' }, meta: object({ requestId: str() }), error: object({ code: str(), message: str() }) }),
    Tokens: object({ accessToken: str(), refreshToken: str(), expiresIn: int, tokenType: str() }),
    User: object({ id: uuid, identifier: str(), displayName: str(), createdAt: time, version: int }),
    Sport: object({ id: uuid, name: str(), slug: str() }),
    Yard: object({ id: uuid, sport_id: uuid, name: str(), hourly_price: int, currency: str(),
      images: { type: 'array', items: str() } }),
    BranchSummary: object({ id: uuid, name: str(), address: str(), timezone: str(), images: { type: 'array', items: str() },
      lat: { type: 'number' }, lng: { type: 'number' }, distance_meters: { type: 'number', nullable: true } }),
    Branch: object({ id: uuid, shop_id: uuid, name: str(), address: str(), description: str(), timezone: str(),
      opening_hour: int, closing_hour: int, images: { type: 'array', items: str() }, rules: { type: 'array', items: str() },
      lat: { type: 'number' }, lng: { type: 'number' }, yards: array('Yard') }),
    Service: object({ id: uuid, branch_id: uuid, name: str(), price: int, currency: str() }),
    Quote: object({ subtotal: int, discount: int, fee: int, total: int, currency: str(), yardId: uuid, branchId: uuid, startsAt: time, endsAt: time }),
    Hold: object({ holdId: uuid, expiresAt: time, quote: ref('Quote') }),
    Booking: object({ id: uuid, user_id: uuid, branch_id: uuid, yard_id: uuid, hold_id: uuid, starts_at: time, ends_at: time,
      amount: int, currency: str(), status: { type: 'string', enum: ['PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'EXPIRED'] },
      payment_expires_at: time, created_at: time, updated_at: time, version: int }),
    PaymentIntent: object({ id: uuid, booking_id: { ...uuid, nullable: true }, order_id: { ...uuid, nullable: true }, user_id: uuid, provider: { type: 'string', enum: ['sandbox'] },
      amount: int, currency: str(), status: { type: 'string', enum: ['CREATED', 'SUCCEEDED', 'EXPIRED', 'NEEDS_REVIEW'] },
      expires_at: time, created_at: time, updated_at: time, version: int }),
    Slot: object({ yard_id: uuid, name: str(), amount: int, currency: str(), starts_at: time, ends_at: time, available: bool }),
    Notification: object({ id: uuid, user_id: uuid, event_id: str(), type: str(), payload: { type: 'object', additionalProperties: true },
      read_at: { ...time, nullable: true }, created_at: time, delivered_at: { ...time, nullable: true } }),
    Content: object({ slug: str(), title: str(), body: str(), version: int, updated_at: time }),
    MembershipPlan: object({ id: uuid, branch_id: uuid, name: str(), price: int, currency: str(), credits: int, duration_days: int, active: bool }),
    MembershipContract: object({ id: uuid, plan_id: uuid, branch_id: uuid, user_id: uuid, remaining_credits: int,
      status: str(), starts_at: time, expires_at: time }),
    MembershipUsage: object({ id: uuid, contract_id: uuid, user_id: uuid, ticket_id: { ...uuid, nullable: true },
      booking_id: { ...uuid, nullable: true }, credits: int, created_at: time }),
    AcademyCenter: object({ id: uuid, branch_id: uuid, name: str(), description: str(), active: bool }),
    AcademyCourse: object({ id: uuid, center_id: uuid, sport_id: uuid, name: str(), description: str(), active: bool }),
    AcademyClass: object({ id: uuid, course_id: uuid, starts_at: time, ends_at: time, capacity: int, price: int, status: str() }),
    Enrollment: object({ id: uuid, class_id: uuid, user_id: uuid, status: str(), created_at: time }),
    Event: object({ id: uuid, branch_id: uuid, organizer_id: uuid, title: str(), description: str(), starts_at: time,
      ends_at: time, capacity: int, ticket_price: int, membership_required: bool, status: str() }),
    Ticket: object({ id: uuid, event_id: uuid, user_id: uuid, status: str(), qrToken: { ...str(), nullable: true }, created_at: time }),
    Match: object({ id: uuid, event_id: uuid, home_team_id: uuid, away_team_id: uuid, status: str(),
      home_score: { ...int, nullable: true }, away_score: { ...int, nullable: true }, created_at: time }),
    Order: object({ id: uuid, user_id: uuid, branch_id: uuid, subtotal: int, discount: int, amount: int,
      currency: str(), status: str(), payment_expires_at: time, created_at: time }),
    Conversation: object({ id: uuid, title: str(), kind: str(), created_by: uuid, next_seq: int, created_at: time }),
    Message: object({ id: uuid, conversation_id: uuid, seq: str(), sender_id: uuid, body: { ...str(), nullable: true }, created_at: time }),
    Review: object({ id: uuid, rating: int, comment: str(), created_at: time }),
    RoleGrant: object({ userId: uuid, role: str(), branchId: { ...uuid, nullable: true }, granted: bool }),
    MediaUpload: object({ id: uuid, mime_type: str(), expected_size: int, status: str(), purpose: str(),
      branch_id: { ...uuid, nullable: true }, yard_id: { ...uuid, nullable: true }, created_at: time,
      completed_at: { ...time, nullable: true } }),
    PresignedPut: object({ uploadId: uuid, method: { type: 'string', enum: ['PUT'] }, url: str(),
      headers: { type: 'object', additionalProperties: str() }, expiresIn: int, status: str(), note: str() })
  };
  const responseMap: Record<string, SchemaObject | { $ref: string }> = {
    'POST /api/v1/public/auth/login': ref('Tokens'), 'POST /api/v1/public/auth/refresh': ref('Tokens'),
    'POST /api/v1/public/auth/register': { allOf: [ref('Tokens'), object({ user: object({ id: uuid, displayName: str() }) })] },
    'POST /api/v1/public/auth/otp/send': object({ challengeId: uuid, expiresAt: time, delivery: str() }),
    'POST /api/v1/public/auth/otp/verify': object({ verificationToken: str(), expiresIn: int }),
    'GET /api/v1/users/me': ref('User'), 'PATCH /api/v1/users/me': ref('User'),
    'DELETE /api/v1/users/me': object({ status: str(), requestedAt: time, earliestPurgeAt: time, note: str() }),
    'GET /api/v1/users/me/linked-accounts': { type: 'array', items: object({ id: uuid, provider: str(), created_at: time }) },
    'POST /api/v1/public/auth/social': { allOf: [ref('Tokens'), object({ user: ref('User') })] },
    'GET /api/v1/public/sports': array('Sport'), 'GET /api/v1/public/branches': page('BranchSummary'),
    'GET /api/v1/public/branches/{id}': ref('Branch'), 'GET /api/v1/public/branches/{id}/services': array('Service'),
    'GET /api/v1/public/branches/{id}/availability': array('Slot'), 'POST /api/v1/quotes': ref('Quote'),
    'POST /api/v1/booking-holds': ref('Hold'), 'POST /api/v1/bookings': ref('Booking'),
    'GET /api/v1/bookings/{id}': ref('Booking'), 'GET /api/v1/users/me/bookings': page('Booking'),
    'POST /api/v1/bookings/{id}/cancel': ref('Booking'),
    'POST /api/v1/booking-series': object({ seriesId: uuid, frequency: str(), bookings: array('Booking'), note: str() }),
    'GET /api/v1/bookings/{id}/participants': { type: 'array', items: object({ user_id: uuid, status: str(), created_at: time }) },
    'POST /api/v1/bookings/{id}/services': object({ booking_id: uuid, service_id: uuid, quantity: int, unit_price: int, amount: int }),
    'POST /api/v1/bookings/{id}/reviews': ref('Review'),
    'GET /api/v1/public/branches/{id}/reviews': array('Review'),
    'GET /api/v1/payment-intents/{id}': ref('PaymentIntent'),
    'POST /api/v1/payment-intents': { allOf: [ref('PaymentIntent'), object({ sandbox: bool, checkoutUrl: { type: 'string', nullable: true } })] },
    'POST /api/v1/webhooks/payments/{provider}': object({ accepted: bool, duplicate: bool, outcome: str() }),
    'GET /api/v1/notifications': page('Notification'), 'POST /api/v1/notifications/{id}/read': ref('Notification'),
    'GET /api/v1/notification-preferences': object({ pushEnabled: bool }), 'PATCH /api/v1/notification-preferences': object({ pushEnabled: bool }),
    'GET /api/v1/public/content/{slug}': ref('Content'),
    'GET /api/v1/public/membership-plans': array('MembershipPlan'),
    'GET /api/v1/public/membership-plans/{id}': ref('MembershipPlan'),
    'POST /api/v1/membership-plans': ref('MembershipPlan'),
    'POST /api/v1/membership-contracts': ref('MembershipContract'),
    'GET /api/v1/users/me/membership-contracts': array('MembershipContract'),
    'GET /api/v1/membership-contracts/{id}': ref('MembershipContract'),
    'GET /api/v1/membership-contracts/{id}/usages': array('MembershipUsage'),
    'GET /api/v1/academy/centers': array('AcademyCenter'),
    'GET /api/v1/academy/centers/{id}': ref('AcademyCenter'),
    'POST /api/v1/academy/centers': ref('AcademyCenter'),
    'GET /api/v1/academy/courses': array('AcademyCourse'),
    'GET /api/v1/academy/courses/{id}': ref('AcademyCourse'),
    'POST /api/v1/academy/courses': ref('AcademyCourse'),
    'GET /api/v1/academy/classes': array('AcademyClass'),
    'GET /api/v1/academy/classes/{id}': ref('AcademyClass'),
    'POST /api/v1/academy/classes': ref('AcademyClass'),
    'POST /api/v1/academy/classes/{id}/enrollments': ref('Enrollment'),
    'GET /api/v1/events': array('Event'),
    'GET /api/v1/events/{id}': ref('Event'),
    'POST /api/v1/events': ref('Event'),
    'POST /api/v1/events/{id}/tickets': ref('Ticket'),
    'GET /api/v1/users/me/tickets': array('Ticket'),
    'GET /api/v1/events/{id}/matches': array('Match'),
    'POST /api/v1/events/{id}/matches': ref('Match'),
    'POST /api/v1/matches/{id}/result': ref('Match'),
    'POST /api/v1/orders': ref('Order'),
    'GET /api/v1/orders/{id}': ref('Order'),
    'GET /api/v1/users/me/orders': array('Order'),
    'POST /api/v1/orders/{id}/cancel': ref('Order'),
    'POST /api/v1/conversation': ref('Conversation'),
    'GET /api/v1/conversation': array('Conversation'),
    'POST /api/v1/conversation/{id}/message': ref('Message'),
    'GET /api/v1/conversation/{id}/messages': array('Message'),
    'POST /api/v1/admin/roles': ref('RoleGrant'),
    'POST /api/v1/media/presign': ref('PresignedPut'),
    'POST /api/v1/branches/{branchId}/images/presign': ref('PresignedPut'),
    'POST /api/v1/branches/{branchId}/images/{id}/complete': object({ uploadId: uuid, status: str(), width: int, height: int }),
    'DELETE /api/v1/branches/{branchId}/images/{id}': object({ archived: bool }),
    'GET /api/v1/media/{id}': ref('MediaUpload'),
    'POST /api/v1/media/{id}/complete': object({ uploadId: uuid, status: str() })
  };
  doc.components = doc.components || {};
  doc.components.schemas = { ...doc.components.schemas, ...schemas };
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of ['get', 'post', 'patch', 'delete'] as const) {
      const op = item[method]; if (!op) continue;
      const code = method === 'post' ? '201' : '200';
      const data = responseMap[`${method.toUpperCase()} ${path}`] || { type: 'object', additionalProperties: true };
      op.responses[code] = { description: 'Success envelope', content: { 'application/json': { schema: object({ data, meta: object({ requestId: str() }), error: { type: 'object', nullable: true } }) } } };
      for (const status of ['400', '401', '404', '409', '429', '500', '503']) op.responses[status] = {
        description: 'Error envelope', content: { 'application/json': { schema: ref('ApiError') } }
      };
    }
  }
  return doc;
}
