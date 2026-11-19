starting the isolated stack (compose project us-check-04) ...

| # | group | what | route | caller | got | expected | ok |
|---|---|---|---|---|---|---|---|
| 1 | 1 provision | admin session | `POST /api/auth/login` | admin password | 200 | 200 | pass |
| 2 | 1 provision | A: create team | `POST /api/teams` | admin | 200 | 200 | pass |
| 3 | 1 provision | A: create service user, global role view-only | `POST /api/users` | admin | 200 | 200 | pass |
| 4 | 1 provision | A: add user to team as team-view-only | `POST /api/teams/cd6bf475-0797-4c67-a9ce-06910ed114e2/users` | admin | 200 | 200 | pass |
| 5 | 1 provision | A: create website owned by the team | `POST /api/websites` | admin | 200 | 200 | pass |
| 6 | 1 provision | A: log in as the service user | `POST /api/auth/login` | service user password | 200 | 200 | pass |
| 7 | 1 provision | A: service user creates its own API key | `POST /api/me/api-keys` | A session | 200 | 200 | pass |
| 8 | 1 provision | B: create team | `POST /api/teams` | admin | 200 | 200 | pass |
| 9 | 1 provision | B: create service user, global role view-only | `POST /api/users` | admin | 200 | 200 | pass |
| 10 | 1 provision | B: add user to team as team-view-only | `POST /api/teams/7095200f-8bd8-4475-a4db-601862fab619/users` | admin | 200 | 200 | pass |
| 11 | 1 provision | B: create website owned by the team | `POST /api/websites` | admin | 200 | 200 | pass |
| 12 | 1 provision | B: log in as the service user | `POST /api/auth/login` | service user password | 200 | 200 | pass |
| 13 | 1 provision | B: service user creates its own API key | `POST /api/me/api-keys` | B session | 200 | 200 | pass |
| 14 | 1 provision | A: create a website outside any team | `POST /api/websites` | admin | 200 | 200 | pass |
| 15 | 1 provision | A: move that website into the team | `POST /api/websites/fe6a97ca-1a5a-425e-9b4e-4b5461cd9236/transfer` | admin | 200 | 200 | pass |
| 16 | 1 provision | A: moved website now belongs to the team | `response body teamId` | admin | team A | team A | pass |
| 17 | 1 provision | A: service user key reads the moved website | `GET /api/websites/fe6a97ca-1a5a-425e-9b4e-4b5461cd9236` | A key | 200 | 200 | pass |
| 18 | 1 provision | A: use the key | `GET /api/me` | A key | 200 | 200 | pass |
| 19 | 1 provision | A: key resolves to the service user | `response body` | A key | svc-tenant-a,api-key | svc-tenant-a,api-key | pass |
| 20 | 1b key ownership | no admin route creates a key for another user | `POST /api/users/7d46ab47-144c-45bc-b093-163f00bcf769/api-keys` | admin | 404 | 404 | pass |
| 21 | 1b key ownership | admin on the key route gets a key for itself | `POST /api/me/api-keys` | admin | 200 | 200 | pass |
| 22 | 1b key ownership | owner of that key (database, read-only) | `api_key.user_id` | read-only SQL | admin | admin | pass |
| 23 | 1b key ownership | keys of service user A unchanged (database, read-only) | `api_key` | read-only SQL | 1 | 1 | pass |
| 24 | 1b key ownership | cleanup: admin deletes its own key | `DELETE /api/me/api-keys/5a07c616-f7a4-417d-8a53-e3d7a2f71d71` | admin | 200 | 200 | pass |
| 25 | 1b key ownership | admin cannot delete the key of user A | `DELETE /api/me/api-keys/c77cfa40-f2bf-4642-811b-525b3c3b8993` | admin | 404 | 404 | pass |
| 26 | 6 stored by Umami | roles, team ownership, key stored as a hash | `user, team_user, website, api_key` | read-only SQL | view-only,team-view-only,true,128,umami_******** | view-only,team-view-only,true,128,umami_******** | pass |
| 27 | 6 stored by Umami | the connection this script uses refuses writes | `CREATE TABLE` | read-only SQL | refused | refused | pass |
| 28 | 2a own data | A key reads A | `GET /api/websites/:id` | A key | 200 | 200 | pass |
| 29 | 2a own data | B key reads B | `GET /api/websites/:id` | B key | 200 | 200 | pass |
| 30 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id` | A key | 401 | 401 | pass |
| 31 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id` | B key | 401 | 401 | pass |
| 32 | 2a own data | A key reads A | `GET /api/websites/:id/active` | A key | 200 | 200 | pass |
| 33 | 2a own data | B key reads B | `GET /api/websites/:id/active` | B key | 200 | 200 | pass |
| 34 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/active` | A key | 401 | 401 | pass |
| 35 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/active` | B key | 401 | 401 | pass |
| 36 | 2a own data | A key reads A | `GET /api/websites/:id/daterange` | A key | 200 | 200 | pass |
| 37 | 2a own data | B key reads B | `GET /api/websites/:id/daterange` | B key | 200 | 200 | pass |
| 38 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/daterange` | A key | 401 | 401 | pass |
| 39 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/daterange` | B key | 401 | 401 | pass |
| 40 | 2a own data | A key reads A | `GET /api/websites/:id/stats` | A key | 200 | 200 | pass |
| 41 | 2a own data | B key reads B | `GET /api/websites/:id/stats` | B key | 200 | 200 | pass |
| 42 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/stats` | A key | 401 | 401 | pass |
| 43 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/stats` | B key | 401 | 401 | pass |
| 44 | 2a own data | A key reads A | `GET /api/websites/:id/pageviews` | A key | 200 | 200 | pass |
| 45 | 2a own data | B key reads B | `GET /api/websites/:id/pageviews` | B key | 200 | 200 | pass |
| 46 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/pageviews` | A key | 401 | 401 | pass |
| 47 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/pageviews` | B key | 401 | 401 | pass |
| 48 | 2a own data | A key reads A | `GET /api/websites/:id/metrics` | A key | 200 | 200 | pass |
| 49 | 2a own data | B key reads B | `GET /api/websites/:id/metrics` | B key | 200 | 200 | pass |
| 50 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/metrics` | A key | 401 | 401 | pass |
| 51 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/metrics` | B key | 401 | 401 | pass |
| 52 | 2a own data | A key reads A | `GET /api/websites/:id/metrics/expanded` | A key | 200 | 200 | pass |
| 53 | 2a own data | B key reads B | `GET /api/websites/:id/metrics/expanded` | B key | 200 | 200 | pass |
| 54 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/metrics/expanded` | A key | 401 | 401 | pass |
| 55 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/metrics/expanded` | B key | 401 | 401 | pass |
| 56 | 2a own data | A key reads A | `GET /api/websites/:id/values` | A key | 200 | 200 | pass |
| 57 | 2a own data | B key reads B | `GET /api/websites/:id/values` | B key | 200 | 200 | pass |
| 58 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/values` | A key | 401 | 401 | pass |
| 59 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/values` | B key | 401 | 401 | pass |
| 60 | 2a own data | A key reads A | `GET /api/websites/:id/sessions` | A key | 200 | 200 | pass |
| 61 | 2a own data | B key reads B | `GET /api/websites/:id/sessions` | B key | 200 | 200 | pass |
| 62 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/sessions` | A key | 401 | 401 | pass |
| 63 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/sessions` | B key | 401 | 401 | pass |
| 64 | 2a own data | A key reads A | `GET /api/websites/:id/sessions/stats` | A key | 200 | 200 | pass |
| 65 | 2a own data | B key reads B | `GET /api/websites/:id/sessions/stats` | B key | 200 | 200 | pass |
| 66 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/sessions/stats` | A key | 401 | 401 | pass |
| 67 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/sessions/stats` | B key | 401 | 401 | pass |
| 68 | 2a own data | A key reads A | `GET /api/websites/:id/sessions/weekly` | A key | 200 | 200 | pass |
| 69 | 2a own data | B key reads B | `GET /api/websites/:id/sessions/weekly` | B key | 200 | 200 | pass |
| 70 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/sessions/weekly` | A key | 401 | 401 | pass |
| 71 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/sessions/weekly` | B key | 401 | 401 | pass |
| 72 | 2a own data | A key reads A | `GET /api/websites/:id/session-data/properties` | A key | 200 | 200 | pass |
| 73 | 2a own data | B key reads B | `GET /api/websites/:id/session-data/properties` | B key | 200 | 200 | pass |
| 74 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/session-data/properties` | A key | 401 | 401 | pass |
| 75 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/session-data/properties` | B key | 401 | 401 | pass |
| 76 | 2a own data | A key reads A | `GET /api/websites/:id/session-data/values` | A key | 200 | 200 | pass |
| 77 | 2a own data | B key reads B | `GET /api/websites/:id/session-data/values` | B key | 200 | 200 | pass |
| 78 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/session-data/values` | A key | 401 | 401 | pass |
| 79 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/session-data/values` | B key | 401 | 401 | pass |
| 80 | 2a own data | A key reads A | `GET /api/websites/:id/session-data/stats` | A key | 200 | 200 | pass |
| 81 | 2a own data | B key reads B | `GET /api/websites/:id/session-data/stats` | B key | 200 | 200 | pass |
| 82 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/session-data/stats` | A key | 401 | 401 | pass |
| 83 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/session-data/stats` | B key | 401 | 401 | pass |
| 84 | 2a own data | A key reads A | `GET /api/websites/:id/session-data/array-series` | A key | 200 | 200 | pass |
| 85 | 2a own data | B key reads B | `GET /api/websites/:id/session-data/array-series` | B key | 200 | 200 | pass |
| 86 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/session-data/array-series` | A key | 401 | 401 | pass |
| 87 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/session-data/array-series` | B key | 401 | 401 | pass |
| 88 | 2a own data | A key reads A | `GET /api/websites/:id/session-data/date-series` | A key | 200 | 200 | pass |
| 89 | 2a own data | B key reads B | `GET /api/websites/:id/session-data/date-series` | B key | 200 | 200 | pass |
| 90 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/session-data/date-series` | A key | 401 | 401 | pass |
| 91 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/session-data/date-series` | B key | 401 | 401 | pass |
| 92 | 2a own data | A key reads A | `GET /api/websites/:id/session-data/numeric-series` | A key | 200 | 200 | pass |
| 93 | 2a own data | B key reads B | `GET /api/websites/:id/session-data/numeric-series` | B key | 200 | 200 | pass |
| 94 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/session-data/numeric-series` | A key | 401 | 401 | pass |
| 95 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/session-data/numeric-series` | B key | 401 | 401 | pass |
| 96 | 2a own data | A key reads A | `GET /api/websites/:id/session-data/numeric-stats` | A key | 200 | 200 | pass |
| 97 | 2a own data | B key reads B | `GET /api/websites/:id/session-data/numeric-stats` | B key | 200 | 200 | pass |
| 98 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/session-data/numeric-stats` | A key | 401 | 401 | pass |
| 99 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/session-data/numeric-stats` | B key | 401 | 401 | pass |
| 100 | 2a own data | A key reads A | `GET /api/websites/:id/session-data/property-series` | A key | 200 | 200 | pass |
| 101 | 2a own data | B key reads B | `GET /api/websites/:id/session-data/property-series` | B key | 200 | 200 | pass |
| 102 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/session-data/property-series` | A key | 401 | 401 | pass |
| 103 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/session-data/property-series` | B key | 401 | 401 | pass |
| 104 | 2a own data | A key reads A | `GET /api/websites/:id/session-data-pivot` | A key | 200 | 200 | pass |
| 105 | 2a own data | B key reads B | `GET /api/websites/:id/session-data-pivot` | B key | 200 | 200 | pass |
| 106 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/session-data-pivot` | A key | 401 | 401 | pass |
| 107 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/session-data-pivot` | B key | 401 | 401 | pass |
| 108 | 2a own data | A key reads A | `GET /api/websites/:id/events` | A key | 200 | 200 | pass |
| 109 | 2a own data | B key reads B | `GET /api/websites/:id/events` | B key | 200 | 200 | pass |
| 110 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/events` | A key | 401 | 401 | pass |
| 111 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/events` | B key | 401 | 401 | pass |
| 112 | 2a own data | A key reads A | `GET /api/websites/:id/events/series` | A key | 200 | 200 | pass |
| 113 | 2a own data | B key reads B | `GET /api/websites/:id/events/series` | B key | 200 | 200 | pass |
| 114 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/events/series` | A key | 401 | 401 | pass |
| 115 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/events/series` | B key | 401 | 401 | pass |
| 116 | 2a own data | A key reads A | `GET /api/websites/:id/events/stats` | A key | 200 | 200 | pass |
| 117 | 2a own data | B key reads B | `GET /api/websites/:id/events/stats` | B key | 200 | 200 | pass |
| 118 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/events/stats` | A key | 401 | 401 | pass |
| 119 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/events/stats` | B key | 401 | 401 | pass |
| 120 | 2a own data | A key reads A | `GET /api/websites/:id/event-data` | A key | 200 | 200 | pass |
| 121 | 2a own data | B key reads B | `GET /api/websites/:id/event-data` | B key | 200 | 200 | pass |
| 122 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/event-data` | A key | 401 | 401 | pass |
| 123 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/event-data` | B key | 401 | 401 | pass |
| 124 | 2a own data | A key reads A | `GET /api/websites/:id/event-data/events` | A key | 200 | 200 | pass |
| 125 | 2a own data | B key reads B | `GET /api/websites/:id/event-data/events` | B key | 200 | 200 | pass |
| 126 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/event-data/events` | A key | 401 | 401 | pass |
| 127 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/event-data/events` | B key | 401 | 401 | pass |
| 128 | 2a own data | A key reads A | `GET /api/websites/:id/event-data/fields` | A key | 200 | 200 | pass |
| 129 | 2a own data | B key reads B | `GET /api/websites/:id/event-data/fields` | B key | 200 | 200 | pass |
| 130 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/event-data/fields` | A key | 401 | 401 | pass |
| 131 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/event-data/fields` | B key | 401 | 401 | pass |
| 132 | 2a own data | A key reads A | `GET /api/websites/:id/event-data/properties` | A key | 200 | 200 | pass |
| 133 | 2a own data | B key reads B | `GET /api/websites/:id/event-data/properties` | B key | 200 | 200 | pass |
| 134 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/event-data/properties` | A key | 401 | 401 | pass |
| 135 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/event-data/properties` | B key | 401 | 401 | pass |
| 136 | 2a own data | A key reads A | `GET /api/websites/:id/event-data/stats` | A key | 200 | 200 | pass |
| 137 | 2a own data | B key reads B | `GET /api/websites/:id/event-data/stats` | B key | 200 | 200 | pass |
| 138 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/event-data/stats` | A key | 401 | 401 | pass |
| 139 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/event-data/stats` | B key | 401 | 401 | pass |
| 140 | 2a own data | A key reads A | `GET /api/websites/:id/event-data/values` | A key | 200 | 200 | pass |
| 141 | 2a own data | B key reads B | `GET /api/websites/:id/event-data/values` | B key | 200 | 200 | pass |
| 142 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/event-data/values` | A key | 401 | 401 | pass |
| 143 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/event-data/values` | B key | 401 | 401 | pass |
| 144 | 2a own data | A key reads A | `GET /api/websites/:id/event-data-pivot` | A key | 200 | 200 | pass |
| 145 | 2a own data | B key reads B | `GET /api/websites/:id/event-data-pivot` | B key | 200 | 200 | pass |
| 146 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/event-data-pivot` | A key | 401 | 401 | pass |
| 147 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/event-data-pivot` | B key | 401 | 401 | pass |
| 148 | 2a own data | A key reads A | `GET /api/websites/:id/event-data-pivot/array-series` | A key | 200 | 200 | pass |
| 149 | 2a own data | B key reads B | `GET /api/websites/:id/event-data-pivot/array-series` | B key | 200 | 200 | pass |
| 150 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/event-data-pivot/array-series` | A key | 401 | 401 | pass |
| 151 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/event-data-pivot/array-series` | B key | 401 | 401 | pass |
| 152 | 2a own data | A key reads A | `GET /api/websites/:id/event-data-pivot/date-series` | A key | 200 | 200 | pass |
| 153 | 2a own data | B key reads B | `GET /api/websites/:id/event-data-pivot/date-series` | B key | 200 | 200 | pass |
| 154 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/event-data-pivot/date-series` | A key | 401 | 401 | pass |
| 155 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/event-data-pivot/date-series` | B key | 401 | 401 | pass |
| 156 | 2a own data | A key reads A | `GET /api/websites/:id/event-data-pivot/numeric-series` | A key | 200 | 200 | pass |
| 157 | 2a own data | B key reads B | `GET /api/websites/:id/event-data-pivot/numeric-series` | B key | 200 | 200 | pass |
| 158 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/event-data-pivot/numeric-series` | A key | 401 | 401 | pass |
| 159 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/event-data-pivot/numeric-series` | B key | 401 | 401 | pass |
| 160 | 2a own data | A key reads A | `GET /api/websites/:id/event-data-pivot/numeric-stats` | A key | 200 | 200 | pass |
| 161 | 2a own data | B key reads B | `GET /api/websites/:id/event-data-pivot/numeric-stats` | B key | 200 | 200 | pass |
| 162 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/event-data-pivot/numeric-stats` | A key | 401 | 401 | pass |
| 163 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/event-data-pivot/numeric-stats` | B key | 401 | 401 | pass |
| 164 | 2a own data | A key reads A | `GET /api/websites/:id/event-data-pivot/property-series` | A key | 200 | 200 | pass |
| 165 | 2a own data | B key reads B | `GET /api/websites/:id/event-data-pivot/property-series` | B key | 200 | 200 | pass |
| 166 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/event-data-pivot/property-series` | A key | 401 | 401 | pass |
| 167 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/event-data-pivot/property-series` | B key | 401 | 401 | pass |
| 168 | 2a own data | A key reads A | `GET /api/websites/:id/funnels` | A key | 200 | 200 | pass |
| 169 | 2a own data | B key reads B | `GET /api/websites/:id/funnels` | B key | 200 | 200 | pass |
| 170 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/funnels` | A key | 401 | 401 | pass |
| 171 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/funnels` | B key | 401 | 401 | pass |
| 172 | 2a own data | A key reads A | `GET /api/websites/:id/funnels/stats` | A key | 200 | 200 | pass |
| 173 | 2a own data | B key reads B | `GET /api/websites/:id/funnels/stats` | B key | 200 | 200 | pass |
| 174 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/funnels/stats` | A key | 401 | 401 | pass |
| 175 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/funnels/stats` | B key | 401 | 401 | pass |
| 176 | 2a own data | A key reads A | `GET /api/websites/:id/goals` | A key | 200 | 200 | pass |
| 177 | 2a own data | B key reads B | `GET /api/websites/:id/goals` | B key | 200 | 200 | pass |
| 178 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/goals` | A key | 401 | 401 | pass |
| 179 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/goals` | B key | 401 | 401 | pass |
| 180 | 2a own data | A key reads A | `GET /api/websites/:id/goals/stats` | A key | 200 | 200 | pass |
| 181 | 2a own data | B key reads B | `GET /api/websites/:id/goals/stats` | B key | 200 | 200 | pass |
| 182 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/goals/stats` | A key | 401 | 401 | pass |
| 183 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/goals/stats` | B key | 401 | 401 | pass |
| 184 | 2a own data | A key reads A | `GET /api/websites/:id/journeys` | A key | 200 | 200 | pass |
| 185 | 2a own data | B key reads B | `GET /api/websites/:id/journeys` | B key | 200 | 200 | pass |
| 186 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/journeys` | A key | 401 | 401 | pass |
| 187 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/journeys` | B key | 401 | 401 | pass |
| 188 | 2a own data | A key reads A | `GET /api/websites/:id/retention` | A key | 200 | 200 | pass |
| 189 | 2a own data | B key reads B | `GET /api/websites/:id/retention` | B key | 200 | 200 | pass |
| 190 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/retention` | A key | 401 | 401 | pass |
| 191 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/retention` | B key | 401 | 401 | pass |
| 192 | 2a own data | A key reads A | `GET /api/websites/:id/attribution` | A key | 200 | 200 | pass |
| 193 | 2a own data | B key reads B | `GET /api/websites/:id/attribution` | B key | 200 | 200 | pass |
| 194 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/attribution` | A key | 401 | 401 | pass |
| 195 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/attribution` | B key | 401 | 401 | pass |
| 196 | 2a own data | A key reads A | `GET /api/websites/:id/breakdown` | A key | 200 | 200 | pass |
| 197 | 2a own data | B key reads B | `GET /api/websites/:id/breakdown` | B key | 200 | 200 | pass |
| 198 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/breakdown` | A key | 401 | 401 | pass |
| 199 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/breakdown` | B key | 401 | 401 | pass |
| 200 | 2a own data | A key reads A | `GET /api/websites/:id/utm/metrics` | A key | 200 | 200 | pass |
| 201 | 2a own data | B key reads B | `GET /api/websites/:id/utm/metrics` | B key | 200 | 200 | pass |
| 202 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/utm/metrics` | A key | 401 | 401 | pass |
| 203 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/utm/metrics` | B key | 401 | 401 | pass |
| 204 | 2a own data | A key reads A | `GET /api/websites/:id/revenue/stats` | A key | 200 | 200 | pass |
| 205 | 2a own data | B key reads B | `GET /api/websites/:id/revenue/stats` | B key | 200 | 200 | pass |
| 206 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/revenue/stats` | A key | 401 | 401 | pass |
| 207 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/revenue/stats` | B key | 401 | 401 | pass |
| 208 | 2a own data | A key reads A | `GET /api/websites/:id/revenue/chart` | A key | 200 | 200 | pass |
| 209 | 2a own data | B key reads B | `GET /api/websites/:id/revenue/chart` | B key | 200 | 200 | pass |
| 210 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/revenue/chart` | A key | 401 | 401 | pass |
| 211 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/revenue/chart` | B key | 401 | 401 | pass |
| 212 | 2a own data | A key reads A | `GET /api/websites/:id/revenue/metrics` | A key | 200 | 200 | pass |
| 213 | 2a own data | B key reads B | `GET /api/websites/:id/revenue/metrics` | B key | 200 | 200 | pass |
| 214 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/revenue/metrics` | A key | 401 | 401 | pass |
| 215 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/revenue/metrics` | B key | 401 | 401 | pass |
| 216 | 2a own data | A key reads A | `GET /api/websites/:id/revenue/sessions` | A key | 200 | 200 | pass |
| 217 | 2a own data | B key reads B | `GET /api/websites/:id/revenue/sessions` | B key | 200 | 200 | pass |
| 218 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/revenue/sessions` | A key | 401 | 401 | pass |
| 219 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/revenue/sessions` | B key | 401 | 401 | pass |
| 220 | 2a own data | A key reads A | `GET /api/websites/:id/performance/stats` | A key | 200 | 200 | pass |
| 221 | 2a own data | B key reads B | `GET /api/websites/:id/performance/stats` | B key | 200 | 200 | pass |
| 222 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/performance/stats` | A key | 401 | 401 | pass |
| 223 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/performance/stats` | B key | 401 | 401 | pass |
| 224 | 2a own data | A key reads A | `GET /api/websites/:id/performance/chart` | A key | 200 | 200 | pass |
| 225 | 2a own data | B key reads B | `GET /api/websites/:id/performance/chart` | B key | 200 | 200 | pass |
| 226 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/performance/chart` | A key | 401 | 401 | pass |
| 227 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/performance/chart` | B key | 401 | 401 | pass |
| 228 | 2a own data | A key reads A | `GET /api/websites/:id/performance/metrics` | A key | 200 | 200 | pass |
| 229 | 2a own data | B key reads B | `GET /api/websites/:id/performance/metrics` | B key | 200 | 200 | pass |
| 230 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/performance/metrics` | A key | 401 | 401 | pass |
| 231 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/performance/metrics` | B key | 401 | 401 | pass |
| 232 | 2a own data | A key reads A | `GET /api/websites/:id/errors` | A key | 200 | 200 | pass |
| 233 | 2a own data | B key reads B | `GET /api/websites/:id/errors` | B key | 200 | 200 | pass |
| 234 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/errors` | A key | 401 | 401 | pass |
| 235 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/errors` | B key | 401 | 401 | pass |
| 236 | 2a own data | A key reads A | `GET /api/websites/:id/errors/stats` | A key | 200 | 200 | pass |
| 237 | 2a own data | B key reads B | `GET /api/websites/:id/errors/stats` | B key | 200 | 200 | pass |
| 238 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/errors/stats` | A key | 401 | 401 | pass |
| 239 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/errors/stats` | B key | 401 | 401 | pass |
| 240 | 2a own data | A key reads A | `GET /api/websites/:id/errors/values` | A key | 200 | 200 | pass |
| 241 | 2a own data | B key reads B | `GET /api/websites/:id/errors/values` | B key | 200 | 200 | pass |
| 242 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/errors/values` | A key | 401 | 401 | pass |
| 243 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/errors/values` | B key | 401 | 401 | pass |
| 244 | 2a own data | A key reads A | `GET /api/websites/:id/heatmaps` | A key | 200 | 200 | pass |
| 245 | 2a own data | B key reads B | `GET /api/websites/:id/heatmaps` | B key | 200 | 200 | pass |
| 246 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/heatmaps` | A key | 401 | 401 | pass |
| 247 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/heatmaps` | B key | 401 | 401 | pass |
| 248 | 2a own data | A key reads A | `GET /api/websites/:id/replays` | A key | 200 | 200 | pass |
| 249 | 2a own data | B key reads B | `GET /api/websites/:id/replays` | B key | 200 | 200 | pass |
| 250 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/replays` | A key | 401 | 401 | pass |
| 251 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/replays` | B key | 401 | 401 | pass |
| 252 | 2a own data | A key reads A | `GET /api/websites/:id/replays/saved` | A key | 200 | 200 | pass |
| 253 | 2a own data | B key reads B | `GET /api/websites/:id/replays/saved` | B key | 200 | 200 | pass |
| 254 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/replays/saved` | A key | 401 | 401 | pass |
| 255 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/replays/saved` | B key | 401 | 401 | pass |
| 256 | 2a own data | A key reads A | `GET /api/websites/:id/export` | A key | 200 | 200 | pass |
| 257 | 2a own data | B key reads B | `GET /api/websites/:id/export` | B key | 200 | 200 | pass |
| 258 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/export` | A key | 401 | 401 | pass |
| 259 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/export` | B key | 401 | 401 | pass |
| 260 | 2a own data | A key reads A | `GET /api/websites/:id/segments` | A key | 200 | 200 | pass |
| 261 | 2a own data | B key reads B | `GET /api/websites/:id/segments` | B key | 200 | 200 | pass |
| 262 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/segments` | A key | 401 | 401 | pass |
| 263 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/segments` | B key | 401 | 401 | pass |
| 264 | 2a own data | A key reads A | `GET /api/websites/:id/annotations` | A key | 200 | 200 | pass |
| 265 | 2a own data | B key reads B | `GET /api/websites/:id/annotations` | B key | 200 | 200 | pass |
| 266 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/annotations` | A key | 401 | 401 | pass |
| 267 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/annotations` | B key | 401 | 401 | pass |
| 268 | 2a own data | A key reads A | `GET /api/websites/:id/shares` | A key | 200 | 200 | pass |
| 269 | 2a own data | B key reads B | `GET /api/websites/:id/shares` | B key | 200 | 200 | pass |
| 270 | 2b cross-tenant read | A key reads B | `GET /api/websites/:id/shares` | A key | 401 | 401 | pass |
| 271 | 2b cross-tenant read | B key reads A | `GET /api/websites/:id/shares` | B key | 401 | 401 | pass |
| 272 | 2a own data | A key reads A realtime | `GET /api/realtime/9e46b307-7b76-4dfe-bd3c-bbec113e011a` | A key | 200 | 200 | pass |
| 273 | 2b cross-tenant read | A key reads B realtime | `GET /api/realtime/16d11757-9270-4b60-a44f-d99d686294c8` | A key | 401 | 401 | pass |
| 274 | 2f public by design | recorder settings of B, no credential | `GET /api/websites/16d11757-9270-4b60-a44f-d99d686294c8/recorder` | nobody | 200 | 200 | pass |
| 275 | 2f public by design | recorder body carries settings only | `response body` | nobody | {"enabled":false} | {"enabled":false} | pass |
| 276 | 2b cross-tenant read | B key finds a session id of B | `GET /api/websites/:id/sessions` | B key | 200 | 200 | pass |
| 277 | 2a own data | B key opens its session | `GET /api/websites/16d11757-9270-4b60-a44f-d99d686294c8/sessions/2eaa51bd-23ec-548f-b993-aea84ccfe16c` | B key | 200 | 200 | pass |
| 278 | 2b cross-tenant read | A key, B website, B session id | `GET /api/websites/:id/sessions/:sessionId` | A key | 401 | 401 | pass |
| 279 | 2b cross-tenant read | A key, A website, B session id | `GET /api/websites/:id/sessions/:sessionId` | A key | 404 no B data | 404 no B data | pass |
| 280 | 2a own data | B key opens its session | `GET /api/websites/16d11757-9270-4b60-a44f-d99d686294c8/sessions/2eaa51bd-23ec-548f-b993-aea84ccfe16c/activity` | B key | 200 | 200 | pass |
| 281 | 2b cross-tenant read | A key, B website, B session id | `GET /api/websites/:id/sessions/:sessionId/activity` | A key | 401 | 401 | pass |
| 282 | 2b cross-tenant read | A key, A website, B session id | `GET /api/websites/:id/sessions/:sessionId/activity` | A key | 200 no B data | 200 no B data | pass |
| 283 | 2a own data | B key opens its session | `GET /api/websites/16d11757-9270-4b60-a44f-d99d686294c8/sessions/2eaa51bd-23ec-548f-b993-aea84ccfe16c/properties` | B key | 200 | 200 | pass |
| 284 | 2b cross-tenant read | A key, B website, B session id | `GET /api/websites/:id/sessions/:sessionId/properties` | A key | 401 | 401 | pass |
| 285 | 2b cross-tenant read | A key, A website, B session id | `GET /api/websites/:id/sessions/:sessionId/properties` | A key | 200 no B data | 200 no B data | pass |
| 286 | 2a own data | B key opens its session | `GET /api/websites/16d11757-9270-4b60-a44f-d99d686294c8/sessions/2eaa51bd-23ec-548f-b993-aea84ccfe16c/replays` | B key | 200 | 200 | pass |
| 287 | 2b cross-tenant read | A key, B website, B session id | `GET /api/websites/:id/sessions/:sessionId/replays` | A key | 401 | 401 | pass |
| 288 | 2b cross-tenant read | A key, A website, B session id | `GET /api/websites/:id/sessions/:sessionId/replays` | A key | 200 no B data | 200 no B data | pass |
| 289 | 2c lists | websites, team access included | `GET /api/websites` | A key | only A | only A | pass |
| 290 | 2c lists | my websites, team access included | `GET /api/me/websites` | A key | only A | only A | pass |
| 291 | 2c lists | my teams | `GET /api/me/teams` | A key | only A | only A | pass |
| 292 | 2c lists | teams | `GET /api/teams` | A key | only A | only A | pass |
| 293 | 2c lists | own team websites | `GET /api/teams/cd6bf475-0797-4c67-a9ce-06910ed114e2/websites` | A key | only A | only A | pass |
| 294 | 2c lists | own team: join code withheld | `GET /api/teams/:id` | A key | withheld | withheld | pass |
| 295 | 2c lists | team B | `GET /api/teams/7095200f-8bd8-4475-a4db-601862fab619` | A key | 401 | 401 | pass |
| 296 | 2c lists | team B members | `GET /api/teams/7095200f-8bd8-4475-a4db-601862fab619/users` | A key | 401 | 401 | pass |
| 297 | 2c lists | team B websites | `GET /api/teams/7095200f-8bd8-4475-a4db-601862fab619/websites` | A key | 401 | 401 | pass |
| 298 | 2c lists | all websites (admin route) | `GET /api/admin/websites` | A key | 401 | 401 | pass |
| 299 | 2c lists | all teams (admin route) | `GET /api/admin/teams` | A key | 401 | 401 | pass |
| 300 | 2c lists | all users (admin route) | `GET /api/admin/users` | A key | 401 | 401 | pass |
| 301 | 2c lists | user B | `GET /api/users/fa1de0a9-adc9-4d3d-a95f-bab194125cd8` | A key | 401 | 401 | pass |
| 302 | 2c lists | user B websites | `GET /api/users/fa1de0a9-adc9-4d3d-a95f-bab194125cd8/websites` | A key | 401 | 401 | pass |
| 303 | 2c lists | own key list, with the key itself | `GET /api/me/api-keys` | A key | 401 | 401 | pass |
| 304 | 2d writes | control: admin creates a second website in team A | `POST /api/websites` | admin | 200 | 200 | pass |
| 305 | 2d writes | control: admin creates annotation | `POST /api/websites/bbf90076-e710-4b00-9f98-c14e7031f214/annotations` | admin | 200 | 200 | pass |
| 306 | 2d writes | create annotation on own website | `POST /api/websites/9e46b307-7b76-4dfe-bd3c-bbec113e011a/annotations` | A key | 401 | 401 | pass |
| 307 | 2d writes | create annotation on B website | `POST /api/websites/16d11757-9270-4b60-a44f-d99d686294c8/annotations` | A key | 401 | 401 | pass |
| 308 | 2d writes | control: admin creates segment | `POST /api/websites/bbf90076-e710-4b00-9f98-c14e7031f214/segments` | admin | 200 | 200 | pass |
| 309 | 2d writes | create segment on own website | `POST /api/websites/9e46b307-7b76-4dfe-bd3c-bbec113e011a/segments` | A key | 401 | 401 | pass |
| 310 | 2d writes | create segment on B website | `POST /api/websites/16d11757-9270-4b60-a44f-d99d686294c8/segments` | A key | 401 | 401 | pass |
| 311 | 2d writes | control: admin creates share link | `POST /api/websites/bbf90076-e710-4b00-9f98-c14e7031f214/shares` | admin | 200 | 200 | pass |
| 312 | 2d writes | create share link on own website | `POST /api/websites/9e46b307-7b76-4dfe-bd3c-bbec113e011a/shares` | A key | 401 | 401 | pass |
| 313 | 2d writes | create share link on B website | `POST /api/websites/16d11757-9270-4b60-a44f-d99d686294c8/shares` | A key | 401 | 401 | pass |
| 314 | 2d writes | create personal website | `POST /api/websites` | A key | 401 | 401 | pass |
| 315 | 2d writes | create website in own team | `POST /api/websites` | A key | 401 | 401 | pass |
| 316 | 2d writes | create website in team B | `POST /api/websites` | A key | 401 | 401 | pass |
| 317 | 2d writes | rename own website | `POST /api/websites/9e46b307-7b76-4dfe-bd3c-bbec113e011a` | A key | 401 | 401 | pass |
| 318 | 2d writes | rename B website | `POST /api/websites/16d11757-9270-4b60-a44f-d99d686294c8` | A key | 401 | 401 | pass |
| 319 | 2d writes | reset own website data | `POST /api/websites/9e46b307-7b76-4dfe-bd3c-bbec113e011a/reset` | A key | 401 | 401 | pass |
| 320 | 2d writes | reset B website data | `POST /api/websites/16d11757-9270-4b60-a44f-d99d686294c8/reset` | A key | 401 | 401 | pass |
| 321 | 2d writes | move B website into own team | `POST /api/websites/16d11757-9270-4b60-a44f-d99d686294c8/transfer` | A key | 401 | 401 | pass |
| 322 | 2d writes | take own website out of the team | `POST /api/websites/9e46b307-7b76-4dfe-bd3c-bbec113e011a/transfer` | A key | 401 | 401 | pass |
| 323 | 2d writes | delete own website | `DELETE /api/websites/9e46b307-7b76-4dfe-bd3c-bbec113e011a` | A key | 401 | 401 | pass |
| 324 | 2d writes | delete B website | `DELETE /api/websites/16d11757-9270-4b60-a44f-d99d686294c8` | A key | 401 | 401 | pass |
| 325 | 2d writes | share B website (generic route) | `POST /api/share` | A key | 401 | 401 | pass |
| 326 | 2d writes | create team | `POST /api/teams` | A key | 401 | 401 | pass |
| 327 | 2d writes | rename own team | `POST /api/teams/cd6bf475-0797-4c67-a9ce-06910ed114e2` | A key | 401 | 401 | pass |
| 328 | 2d writes | rename team B | `POST /api/teams/7095200f-8bd8-4475-a4db-601862fab619` | A key | 401 | 401 | pass |
| 329 | 2d writes | raise own team role | `POST /api/teams/cd6bf475-0797-4c67-a9ce-06910ed114e2/users/7d46ab47-144c-45bc-b093-163f00bcf769` | A key | 401 | 401 | pass |
| 330 | 2d writes | add self to team B | `POST /api/teams/7095200f-8bd8-4475-a4db-601862fab619/users` | A key | 401 | 401 | pass |
| 331 | 2d writes | delete own team | `DELETE /api/teams/cd6bf475-0797-4c67-a9ce-06910ed114e2` | A key | 401 | 401 | pass |
| 332 | 2d writes | delete team B | `DELETE /api/teams/7095200f-8bd8-4475-a4db-601862fab619` | A key | 401 | 401 | pass |
| 333 | 2d writes | create another key with the key | `POST /api/me/api-keys` | A key | 401 | 401 | pass |
| 334 | 2d writes | delete own key with the key | `DELETE /api/me/api-keys/c77cfa40-f2bf-4642-811b-525b3c3b8993` | A key | 401 | 401 | pass |
| 335 | 2d writes | change own password with the key | `POST /api/me/password` | A key | 401 | 401 | pass |
| 336 | 2d writes | create a user | `POST /api/users` | A key | 401 | 401 | pass |
| 337 | 2d writes | make self admin | `POST /api/users/7d46ab47-144c-45bc-b093-163f00bcf769` | A key | 401 | 401 | pass |
| 338 | 2d writes | delete user B | `DELETE /api/users/fa1de0a9-adc9-4d3d-a95f-bab194125cd8` | A key | 401 | 401 | pass |
| 339 | 2d writes | join a team with a wrong join code | `POST /api/teams/join` | A key | 404 | 404 | pass |
| 340 | 2d writes | no credential at all | `GET /api/websites/9e46b307-7b76-4dfe-bd3c-bbec113e011a/stats` | nobody | 401 | 401 | pass |
| 341 | 2e planted leaks | control: service user created with global role user | `POST /api/users` | admin | 200 | 200 | pass |
| 342 | 2e planted leaks | control: same team-view-only membership in A | `POST /api/teams/cd6bf475-0797-4c67-a9ce-06910ed114e2/users` | admin | 200 | 200 | pass |
| 343 | 2e planted leaks | LEAK global role user: creates its own website | `POST /api/websites` | wrong-role key | 200 | 200 | pass |
| 344 | 2e planted leaks | LEAK global role user: creates its own team | `POST /api/teams` | wrong-role key | 200 | 200 | pass |
| 345 | 2e planted leaks | before the join code: cannot read B | `GET /api/websites/16d11757-9270-4b60-a44f-d99d686294c8/stats` | wrong-role key | 401 | 401 | pass |
| 346 | 2e planted leaks | LEAK join code of B: any key joins team B | `POST /api/teams/join` | wrong-role key | 200 | 200 | pass |
| 347 | 2e planted leaks | LEAK after joining: reads B | `GET /api/websites/16d11757-9270-4b60-a44f-d99d686294c8/stats` | wrong-role key | 200 | 200 | pass |
| 348 | 2e planted leaks | cleanup: admin deletes the control user | `DELETE /api/users/16054b5c-b1e0-4ee2-ab82-06b244cb4e34` | admin | 200 | 200 | pass |
| 349 | 3 revocation | admin sets a new password on the service user | `POST /api/users/7d46ab47-144c-45bc-b093-163f00bcf769` | admin | 200 | 200 | pass |
| 350 | 3 revocation | old session token after the password change | `GET /api/me` | A old session | 401 | 401 | pass |
| 351 | 3 revocation | API key after the password change (not revoked by it) | `GET /api/websites/9e46b307-7b76-4dfe-bd3c-bbec113e011a/stats` | A key | 200 | 200 | pass |
| 352 | 3 revocation | log in with the new password | `POST /api/auth/login` | service user password | 200 | 200 | pass |
| 353 | 3 revocation | create the replacement key | `POST /api/me/api-keys` | A session | 200 | 200 | pass |
| 354 | 3 revocation | delete the first key | `DELETE /api/me/api-keys/c77cfa40-f2bf-4642-811b-525b3c3b8993` | A session | 200 | 200 | pass |
| 355 | 3 revocation | first key, next request | `GET /api/websites/9e46b307-7b76-4dfe-bd3c-bbec113e011a/stats` | A revoked key | 401 | 401 | pass |
| 356 | 3 revocation | replacement key | `GET /api/websites/9e46b307-7b76-4dfe-bd3c-bbec113e011a/stats` | A key 2 | 200 | 200 | pass |
| 357 | 3 revocation | admin removes the user from the team | `DELETE /api/teams/cd6bf475-0797-4c67-a9ce-06910ed114e2/users/7d46ab47-144c-45bc-b093-163f00bcf769` | admin | 200 | 200 | pass |
| 358 | 3 revocation | key still identifies the user | `GET /api/me` | A key 2 | 200 | 200 | pass |
| 359 | 3 revocation | but reads nothing | `GET /api/websites/9e46b307-7b76-4dfe-bd3c-bbec113e011a/stats` | A key 2 | 401 | 401 | pass |
| 360 | 3 revocation | admin deletes the user | `DELETE /api/users/7d46ab47-144c-45bc-b093-163f00bcf769` | admin | 200 | 200 | pass |
| 361 | 3 revocation | key after the user is deleted | `GET /api/me` | A key 2 | 401 | 401 | pass |
| 362 | 3 revocation | session token after the user is deleted | `GET /api/me` | A session | 401 | 401 | pass |
| 363 | 3 revocation | keys left for the deleted user (database, read-only) | `api_key` | read-only SQL | 0 | 0 | pass |
| 364 | 4 removal | admin creates a share link for B (to see it go) | `POST /api/websites/16d11757-9270-4b60-a44f-d99d686294c8/shares` | admin | 200 | 200 | pass |
| 365 | 4 removal | share link is public before removal | `GET /api/share/anWlZwftORUGTtrw` | nobody | 200 | 200 | pass |
| 366 | 4 removal | admin deletes the website | `DELETE /api/websites/16d11757-9270-4b60-a44f-d99d686294c8` | admin | 200 | 200 | pass |
| 367 | 4 removal | B key reads the deleted website | `GET /api/websites/16d11757-9270-4b60-a44f-d99d686294c8/stats` | B key | 401 | 401 | pass |
| 368 | 4 removal | share link after removal | `GET /api/share/anWlZwftORUGTtrw` | nobody | 404 | 404 | pass |
| 369 | 4 removal | admin deletes the team | `DELETE /api/teams/7095200f-8bd8-4475-a4db-601862fab619` | admin | 200 | 200 | pass |
| 370 | 4 removal | B key still authenticates: the user outlives the team | `GET /api/me` | B key | 200 | 200 | pass |
| 371 | 4 removal | admin deletes the service user | `DELETE /api/users/fa1de0a9-adc9-4d3d-a95f-bab194125cd8` | admin | 200 | 200 | pass |
| 372 | 4 removal | B key after the user is deleted | `GET /api/me` | B key | 401 | 401 | pass |
| 373 | 4 removal | rows left for tenant B (database, read-only) | `all tenant tables` | read-only SQL | website=0 events=0 sessions=0 event_data=0 shares=0 team=0 team_users=0 user=0 keys=0 | website=0 events=0 sessions=0 event_data=0 shares=0 team=0 team_users=0 user=0 keys=0 | pass |

revoked key refused on the next request, 13 ms after the delete returned
tenant B rows before removal:           website=1 events=3 sessions=1 event_data=1 shares=1 team=1 team_users=2 user=1 keys=1
tenant B rows after website and team:   website=0 events=0 sessions=0 event_data=0 shares=0 team=0 team_users=0 user=1 keys=1
tenant B rows after the user as well:   website=0 events=0 sessions=0 event_data=0 shares=0 team=0 team_users=0 user=0 keys=0

373 rows, 0 not as expected
VERDICT: PASSES WITH A STATED CORRECTION TO THE DESIGN.
Teams, service users, memberships and websites are provisioned with the admin session.
A key is not: Umami only lets a user create and delete its own keys, from its own login.
