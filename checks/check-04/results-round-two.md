starting the isolated stack (compose project us-check-04-r2) ...
Umami at http://127.0.0.1:59706

| # | group | what | route | caller | got | expected | ok |
|---|---|---|---|---|---|---|---|
| 1 | A provision | A: first run | `worker.provision` | worker | completed | completed | pass |
| 2 | A provision | A: what Umami stored (database, read-only) | `team, user, team_user, website, board, api_key` | read-only SQL | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | pass |
| 3 | A provision | A: the key reads its website | `GET /api/websites/5758992c-5c95-482b-bbd0-ebd19b782c7f/stats` | A key | 200 | 200 | pass |
| 4 | A provision | A: the key resolves to the service user | `GET /api/me` | A key | svc-tenant-a,view-only,api-key | svc-tenant-a,view-only,api-key | pass |
| 5 | A provision | tenant-a: secrets the worker held that are still accepted | `login, /api/me, /api/teams/join` | nobody, probe key | passwords 0/1 sessions 0/1 replaced keys 0/0 earlier join codes 0/1 | passwords 0/1 sessions 0/1 replaced keys 0/0 earlier join codes 0/1 | pass |
| 6 | A provision | B: first run | `worker.provision` | worker | completed | completed | pass |
| 7 | A provision | B: what Umami stored (database, read-only) | `team, user, team_user, website, board, api_key` | read-only SQL | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | pass |
| 8 | A provision | B: the key reads its website | `GET /api/websites/0947bafe-cf7e-4a39-a23c-6f7525e23443/stats` | B key | 200 | 200 | pass |
| 9 | A provision | B: the key resolves to the service user | `GET /api/me` | B key | svc-tenant-b,view-only,api-key | svc-tenant-b,view-only,api-key | pass |
| 10 | A provision | tenant-b: secrets the worker held that are still accepted | `login, /api/me, /api/teams/join` | nobody, probe key | passwords 0/1 sessions 0/1 replaced keys 0/0 earlier join codes 0/1 | passwords 0/1 sessions 0/1 replaced keys 0/0 earlier join codes 0/1 | pass |
| 11 | A0 no admin key route | the only code that inserts a key | `umami/src, apiKey.create(` | source | queries/prisma/apiKey.ts | queries/prisma/apiKey.ts | pass |
| 12 | A0 no admin key route | the only route that calls it | `umami/src, createApiKey(` | source | app/api/me/api-keys/route.ts | app/api/me/api-keys/route.ts | pass |
| 13 | A0 no admin key route | that route takes the owner from the caller's session | `app/api/me/api-keys/route.ts` | source | auth.user.id | auth.user.id | pass |
| 14 | A0 no admin key route | guessed admin route does not exist | `POST /api/users/e541555d-77f7-49e7-8d8e-b79d08b6783a/api-keys` | admin | 404 | 404 | pass |
| 15 | A0 no admin key route | guessed admin route does not exist | `POST /api/admin/users/e541555d-77f7-49e7-8d8e-b79d08b6783a/api-keys` | admin | 404 | 404 | pass |
| 16 | A0 no admin key route | guessed admin route does not exist | `POST /api/admin/api-keys` | admin | 404 | 404 | pass |
| 17 | A0 no admin key route | admin on the key route, naming user A in the body | `POST /api/me/api-keys` | admin | 200 | 200 | pass |
| 18 | A0 no admin key route | owner of that key (database, read-only) | `api_key.user_id` | read-only SQL | admin | admin | pass |
| 19 | A0 no admin key route | keys of service user A unchanged (database, read-only) | `api_key` | read-only SQL | 1 | 1 | pass |
| 20 | A0 no admin key route | cleanup: admin deletes its own key | `DELETE /api/me/api-keys/0f9f9294-d8da-430e-ac60-b33b66a63729` | admin | 200 | 200 | pass |
| 21 | A0 no admin key route | admin cannot delete the key of user A | `DELETE /api/me/api-keys/7b72e927-83ba-41f0-bc4d-c2a751aab921` | admin | 404 | 404 | pass |
| 22 | A provision | A: the password the worker signed in with, after the run | `POST /api/auth/login` | that password | 401 | 401 | pass |
| 23 | A provision | A: the session the worker created the key with, after the run | `GET /api/me` | that session | 401 | 401 | pass |
| 24 | A provision | A: that session can no longer create a key | `POST /api/me/api-keys` | that session | 401 | 401 | pass |
| 25 | A provision | A: the key cannot create a key or a session | `POST /api/me/api-keys` | A key | 401 | 401 | pass |
| 26 | A provision | A: the key cannot set a password | `POST /api/me/password` | A key | 401 | 401 | pass |
| 27 | A provision | no route removes a password: admin sets it to empty | `POST /api/users/e541555d-77f7-49e7-8d8e-b79d08b6783a` | admin | 400 | 400 | pass |
| 28 | A provision | no route removes a password: admin sets it to null | `POST /api/users/e541555d-77f7-49e7-8d8e-b79d08b6783a` | admin | 400 | 400 | pass |
| 29 | A provision | A: a later run by a new worker, given no key and no password | `worker.provision` | worker | completed | completed | pass |
| 30 | A provision | A: that run issued a new key | `worker.provision` | worker | new key | new key | pass |
| 31 | A provision | A: the new key reads the website | `GET /api/websites/5758992c-5c95-482b-bbd0-ebd19b782c7f/stats` | A key | 200 | 200 | pass |
| 32 | A provision | A: the first key is refused | `GET /api/me` | A first key | 401 | 401 | pass |
| 33 | A provision | A: still one of everything (database, read-only) | `all tenant tables` | read-only SQL | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | pass |
| 34 | A provision | tenant-a: secrets the worker held that are still accepted | `login, /api/me, /api/teams/join` | nobody, probe key | passwords 0/2 sessions 0/2 replaced keys 0/1 earlier join codes 0/2 | passwords 0/2 sessions 0/2 replaced keys 0/1 earlier join codes 0/2 | pass |
| 35 | B re-run | A: second run, given the key the console holds | `worker.provision` | worker | completed | completed | pass |
| 36 | B re-run | A: same team, user and website ids | `worker.provision` | worker | same ids | same ids | pass |
| 37 | B re-run | A: the key was kept, not replaced | `api_key` | worker, read-only SQL | kept, same row | kept, same row | pass |
| 38 | B re-run | A: one of everything (database, read-only) | `all tenant tables` | read-only SQL | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | pass |
| 39 | B re-run | A: the key still reads its website | `GET /api/websites/5758992c-5c95-482b-bbd0-ebd19b782c7f/stats` | A key | 200 | 200 | pass |
| 40 | B re-run | stopped after "team" | `worker.provision` | worker | interrupted | interrupted | pass |
| 41 | B re-run | stopped after "team": run again | `worker.provision` | worker | completed | completed | pass |
| 42 | B re-run | stopped after "team": one of everything (database, read-only) | `all tenant tables` | read-only SQL | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | pass |
| 43 | B re-run | stopped after "team": the key reads its website | `GET /api/websites/fcf30228-3ef6-4b82-b6b9-f5bae6c8b2af/stats` | its key | 200 | 200 | pass |
| 44 | B re-run | int-team: secrets the worker held that are still accepted | `login, /api/me, /api/teams/join` | nobody, probe key | passwords 0/1 sessions 0/1 replaced keys 0/0 earlier join codes 0/1 | passwords 0/1 sessions 0/1 replaced keys 0/0 earlier join codes 0/1 | pass |
| 45 | B re-run | stopped after "join-code" | `worker.provision` | worker | interrupted | interrupted | pass |
| 46 | B re-run | stopped after "join-code": run again | `worker.provision` | worker | completed | completed | pass |
| 47 | B re-run | stopped after "join-code": one of everything (database, read-only) | `all tenant tables` | read-only SQL | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | pass |
| 48 | B re-run | stopped after "join-code": the key reads its website | `GET /api/websites/a2f46fc8-919f-4237-a245-72f92a352028/stats` | its key | 200 | 200 | pass |
| 49 | B re-run | int-join-code: secrets the worker held that are still accepted | `login, /api/me, /api/teams/join` | nobody, probe key | passwords 0/1 sessions 0/1 replaced keys 0/0 earlier join codes 0/2 | passwords 0/1 sessions 0/1 replaced keys 0/0 earlier join codes 0/2 | pass |
| 50 | B re-run | stopped after "reserve-id" | `worker.provision` | worker | interrupted | interrupted | pass |
| 51 | B re-run | stopped after "reserve-id": run again | `worker.provision` | worker | completed | completed | pass |
| 52 | B re-run | stopped after "reserve-id": one of everything (database, read-only) | `all tenant tables` | read-only SQL | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | pass |
| 53 | B re-run | stopped after "reserve-id": the key reads its website | `GET /api/websites/52fa2b7b-c5fd-4875-a88c-2f27cee1f702/stats` | its key | 200 | 200 | pass |
| 54 | B re-run | int-reserve-id: secrets the worker held that are still accepted | `login, /api/me, /api/teams/join` | nobody, probe key | passwords 0/1 sessions 0/1 replaced keys 0/0 earlier join codes 0/2 | passwords 0/1 sessions 0/1 replaced keys 0/0 earlier join codes 0/2 | pass |
| 55 | B re-run | stopped after "user" | `worker.provision` | worker | interrupted | interrupted | pass |
| 56 | B re-run | stopped after "user": run again | `worker.provision` | worker | completed | completed | pass |
| 57 | B re-run | stopped after "user": one of everything (database, read-only) | `all tenant tables` | read-only SQL | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | pass |
| 58 | B re-run | stopped after "user": the key reads its website | `GET /api/websites/1304f303-acff-40ac-b5a6-1f9f4a01046c/stats` | its key | 200 | 200 | pass |
| 59 | B re-run | int-user: secrets the worker held that are still accepted | `login, /api/me, /api/teams/join` | nobody, probe key | passwords 0/1 sessions 0/1 replaced keys 0/0 earlier join codes 0/2 | passwords 0/1 sessions 0/1 replaced keys 0/0 earlier join codes 0/2 | pass |
| 60 | B re-run | stopped after "membership" | `worker.provision` | worker | interrupted | interrupted | pass |
| 61 | B re-run | stopped after "membership": run again | `worker.provision` | worker | completed | completed | pass |
| 62 | B re-run | stopped after "membership": one of everything (database, read-only) | `all tenant tables` | read-only SQL | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | pass |
| 63 | B re-run | stopped after "membership": the key reads its website | `GET /api/websites/cd9fc121-f226-4b78-82f2-d0618babb375/stats` | its key | 200 | 200 | pass |
| 64 | B re-run | int-membership: secrets the worker held that are still accepted | `login, /api/me, /api/teams/join` | nobody, probe key | passwords 0/1 sessions 0/1 replaced keys 0/0 earlier join codes 0/2 | passwords 0/1 sessions 0/1 replaced keys 0/0 earlier join codes 0/2 | pass |
| 65 | B re-run | stopped after "website" | `worker.provision` | worker | interrupted | interrupted | pass |
| 66 | B re-run | stopped after "website": run again | `worker.provision` | worker | completed | completed | pass |
| 67 | B re-run | stopped after "website": one of everything (database, read-only) | `all tenant tables` | read-only SQL | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | pass |
| 68 | B re-run | stopped after "website": the key reads its website | `GET /api/websites/09180acc-befb-4e96-bb27-8cbbcf76ce45/stats` | its key | 200 | 200 | pass |
| 69 | B re-run | int-website: secrets the worker held that are still accepted | `login, /api/me, /api/teams/join` | nobody, probe key | passwords 0/1 sessions 0/1 replaced keys 0/0 earlier join codes 0/2 | passwords 0/1 sessions 0/1 replaced keys 0/0 earlier join codes 0/2 | pass |
| 70 | B re-run | stopped after "password" | `worker.provision` | worker | interrupted | interrupted | pass |
| 71 | B re-run | stopped after "password": run again | `worker.provision` | worker | completed | completed | pass |
| 72 | B re-run | stopped after "password": one of everything (database, read-only) | `all tenant tables` | read-only SQL | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | pass |
| 73 | B re-run | stopped after "password": the key reads its website | `GET /api/websites/da140379-8ba3-4277-891a-47f3f5567fdd/stats` | its key | 200 | 200 | pass |
| 74 | B re-run | int-password: secrets the worker held that are still accepted | `login, /api/me, /api/teams/join` | nobody, probe key | passwords 0/2 sessions 0/1 replaced keys 0/0 earlier join codes 0/2 | passwords 0/2 sessions 0/1 replaced keys 0/0 earlier join codes 0/2 | pass |
| 75 | B re-run | stopped after "sign-in" | `worker.provision` | worker | interrupted | interrupted | pass |
| 76 | B re-run | stopped after "sign-in": until the next run, the session it left is still accepted | `GET /api/me` | that session | 200 | 200 | pass |
| 77 | B re-run | stopped after "sign-in": run again | `worker.provision` | worker | completed | completed | pass |
| 78 | B re-run | stopped after "sign-in": one of everything (database, read-only) | `all tenant tables` | read-only SQL | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | pass |
| 79 | B re-run | stopped after "sign-in": the key reads its website | `GET /api/websites/67a473da-3a98-4b08-8f44-f7f0f2616ee8/stats` | its key | 200 | 200 | pass |
| 80 | B re-run | int-sign-in: secrets the worker held that are still accepted | `login, /api/me, /api/teams/join` | nobody, probe key | passwords 0/2 sessions 0/2 replaced keys 0/0 earlier join codes 0/2 | passwords 0/2 sessions 0/2 replaced keys 0/0 earlier join codes 0/2 | pass |
| 81 | B re-run | stopped after "key" | `worker.provision` | worker | interrupted | interrupted | pass |
| 82 | B re-run | stopped after "key": run again | `worker.provision` | worker | completed | completed | pass |
| 83 | B re-run | stopped after "key": one of everything (database, read-only) | `all tenant tables` | read-only SQL | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | pass |
| 84 | B re-run | stopped after "key": the key reads its website | `GET /api/websites/4412f8bb-0bd2-44a2-9922-69aadb32b7fe/stats` | its key | 200 | 200 | pass |
| 85 | B re-run | int-key: secrets the worker held that are still accepted | `login, /api/me, /api/teams/join` | nobody, probe key | passwords 0/2 sessions 0/2 replaced keys 0/1 earlier join codes 0/2 | passwords 0/2 sessions 0/2 replaced keys 0/1 earlier join codes 0/2 | pass |
| 86 | B re-run | stopped after "prune-keys" | `worker.provision` | worker | interrupted | interrupted | pass |
| 87 | B re-run | stopped after "prune-keys": run again | `worker.provision` | worker | completed | completed | pass |
| 88 | B re-run | stopped after "prune-keys": one of everything (database, read-only) | `all tenant tables` | read-only SQL | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | pass |
| 89 | B re-run | stopped after "prune-keys": the key reads its website | `GET /api/websites/546cc862-f5ec-438e-b023-5c782bf7d01a/stats` | its key | 200 | 200 | pass |
| 90 | B re-run | int-prune-keys: secrets the worker held that are still accepted | `login, /api/me, /api/teams/join` | nobody, probe key | passwords 0/2 sessions 0/2 replaced keys 0/1 earlier join codes 0/2 | passwords 0/2 sessions 0/2 replaced keys 0/1 earlier join codes 0/2 | pass |
| 91 | B re-run | stopped after "discard-password" | `worker.provision` | worker | interrupted | interrupted | pass |
| 92 | B re-run | stopped after "discard-password": run again | `worker.provision` | worker | completed | completed | pass |
| 93 | B re-run | stopped after "discard-password": one of everything (database, read-only) | `all tenant tables` | read-only SQL | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | pass |
| 94 | B re-run | stopped after "discard-password": the key reads its website | `GET /api/websites/6a4495e1-6a6b-4086-8bba-3b63308985e8/stats` | its key | 200 | 200 | pass |
| 95 | B re-run | int-discard-password: secrets the worker held that are still accepted | `login, /api/me, /api/teams/join` | nobody, probe key | passwords 0/2 sessions 0/2 replaced keys 0/1 earlier join codes 0/2 | passwords 0/2 sessions 0/2 replaced keys 0/1 earlier join codes 0/2 | pass |
| 96 | D join code | control: before joining, the key cannot read the team website | `GET /api/websites/436f4b4a-be77-4e78-9290-fc98b7cf553c/stats` | probe key | 401 | 401 | pass |
| 97 | D join code | control LEAK: a view-only key joins with the code the team was created with | `POST /api/teams/join` | probe key | 200 | 200 | pass |
| 98 | D join code | control LEAK: it joins with a writing role | `response body role` | probe key | team-member | team-member | pass |
| 99 | D join code | control LEAK: it reads the team website | `GET /api/websites/436f4b4a-be77-4e78-9290-fc98b7cf553c/stats` | probe key | 200 | 200 | pass |
| 100 | D join code | control LEAK: it renames the team website | `POST /api/websites/436f4b4a-be77-4e78-9290-fc98b7cf553c` | probe key | 200 | 200 | pass |
| 101 | D join code | cleanup: admin removes the key's user from the team | `DELETE /api/teams/e5876c4d-8839-4ba7-8e3f-26e4a6c22985/users/14293b98-40e4-4be8-9ce8-a17e5c8d42a6` | admin | 200 | 200 | pass |
| 102 | D join code | after removal the key cannot read it | `GET /api/websites/436f4b4a-be77-4e78-9290-fc98b7cf553c/stats` | probe key | 401 | 401 | pass |
| 103 | D join code | the code cannot be set to null | `POST /api/teams/e5876c4d-8839-4ba7-8e3f-26e4a6c22985` | admin | 400 | 400 | pass |
| 104 | D join code | the code cannot be longer than 50 characters | `POST /api/teams/e5876c4d-8839-4ba7-8e3f-26e4a6c22985` | admin | 400 | 400 | pass |
| 105 | D join code | the code can be set to an empty string | `POST /api/teams/e5876c4d-8839-4ba7-8e3f-26e4a6c22985` | admin | 200 | 200 | pass |
| 106 | D join code | LEAK: an empty code is a code; a key joins with it | `POST /api/teams/join` | probe key | 200 | 200 | pass |
| 107 | D join code | a second team cannot be emptied: codes are unique | `POST /api/teams/577f516f-ecea-4118-9b95-81a7ba9602fa` | admin | 500 | 500 | pass |
| 108 | D join code | rotation: admin sets a random 50-character code | `POST /api/teams/e5876c4d-8839-4ba7-8e3f-26e4a6c22985` | admin | 200 | 200 | pass |
| 109 | D join code | after rotation the code as created is refused | `POST /api/teams/join` | probe key | 404 | 404 | pass |
| 110 | D join code | after rotation the empty code is refused | `POST /api/teams/join` | probe key | 404 | 404 | pass |
| 111 | D join code | tenant B: every code its team had before the last rotation is refused | `POST /api/teams/join` | probe key | 0 of 1 accepted | 0 of 1 accepted | pass |
| 112 | D join code | tenant B: the current code is 50 characters and was never one of them | `GET /api/teams/:id` | admin | rotated | rotated | pass |
| 113 | D join code | tenant B: its own key is not shown the code | `GET /api/teams/:id` | B key | withheld | withheld | pass |
| 114 | D join code | tenant B: its own key is not shown the code | `GET /api/teams` | B key | withheld | withheld | pass |
| 115 | D join code | tenant B: its own key is not shown the code | `GET /api/me/teams` | B key | withheld | withheld | pass |
| 116 | D join code | tenant B: its key cannot change the code | `POST /api/teams/db561470-0f25-47fa-aacd-de1537566754` | B key | 401 | 401 | pass |
| 117 | D join code | STAYS OPEN: a key whose holder has read the current code (admin or database) joins | `POST /api/teams/join` | probe key | 200 | 200 | pass |
| 118 | E share link | control: the direct route is refused, as in round one | `POST /api/websites/3b06122d-14b2-4872-92f6-73c53a11e644/shares` | control key | 401 | 401 | pass |
| 119 | E share link | control LEAK: a view-only key saves a personal dashboard that shows the team website | `POST /api/dashboard` | control key | 200 | 200 | pass |
| 120 | E share link | control LEAK: and creates a share link for that dashboard | `POST /api/boards/b9065fd2-79b4-4cd3-be4f-2a4a43f0963c/shares` | control key | 200 | 200 | pass |
| 121 | E share link | control LEAK: the link opens with no credential | `GET /api/share/k3JBeLvDEc1yfLS7` | nobody | 200 | 200 | pass |
| 122 | E share link | control LEAK: the link reads the website totals | `GET /api/websites/:id/stats` | share link | 200 pageviews=2 | 200 pageviews=2 | pass |
| 123 | E share link | control: the link does not read visitor rows | `GET /api/websites/:id/sessions` | share link | 401 | 401 | pass |
| 124 | E share link | control: the key is revoked | `DELETE /api/me/api-keys/5f532649-fc51-4c2c-811f-8fafe137fa6b` | control session | 200 | 200 | pass |
| 125 | E share link | control LEAK: the link outlives the key that made it | `GET /api/websites/:id/stats` | share link | 200 | 200 | pass |
| 126 | E share link | control: the admin can list the links of that dashboard | `GET /api/boards/:id/shares` | admin | 1 listed | 1 listed | pass |
| 127 | E share link | control: the admin deletes the link | `DELETE /api/share/id/af92f6cf-4c48-4fa8-860b-837d1ae9fdb1` | admin | 200 | 200 | pass |
| 128 | E share link | control: the deleted link reads nothing | `GET /api/websites/:id/stats` | share link | 401 | 401 | pass |
| 129 | E share link | control LEAK: the generic route makes a link too (login session) | `POST /api/share` | control session | 200 | 200 | pass |
| 130 | E share link | control: the admin deletes the user | `DELETE /api/users/b9065fd2-79b4-4cd3-be4f-2a4a43f0963c` | admin | 200 | 200 | pass |
| 131 | E share link | control: its links are gone with it | `GET /api/share/WzQ8w7xW42sO2pHC` | nobody | 404 | 404 | pass |
| 132 | E share link | tenant A: read its personal dashboard | `GET /api/dashboard` | A key | 401 | 401 | pass |
| 133 | E share link | tenant A: save a personal dashboard | `POST /api/dashboard` | A key | 401 | 401 | pass |
| 134 | E share link | tenant A: create a share link for the board that holds its id | `POST /api/boards/e541555d-77f7-49e7-8d8e-b79d08b6783a/shares` | A key | 401 | 401 | pass |
| 135 | E share link | tenant A: generic route, its own id as a board | `POST /api/share` | A key | 401 | 401 | pass |
| 136 | E share link | tenant A: generic route, its own website | `POST /api/share` | A key | 401 | 401 | pass |
| 137 | E share link | tenant A: website route, its own website | `POST /api/websites/5758992c-5c95-482b-bbd0-ebd19b782c7f/shares` | A key | 401 | 401 | pass |
| 138 | E share link | tenant A: create a personal board | `POST /api/boards` | A key | 401 | 401 | pass |
| 139 | E share link | tenant A: create a team board | `POST /api/boards` | A key | 401 | 401 | pass |
| 140 | E share link | tenant A: rename the board that holds its id | `POST /api/boards/e541555d-77f7-49e7-8d8e-b79d08b6783a` | A key | 401 | 401 | pass |
| 141 | E share link | tenant A: delete the board that holds its id | `DELETE /api/boards/e541555d-77f7-49e7-8d8e-b79d08b6783a` | A key | 401 | 401 | pass |
| 142 | E share link | tenant A: create a link | `POST /api/links` | A key | 401 | 401 | pass |
| 143 | E share link | tenant A: create a pixel | `POST /api/pixels` | A key | 401 | 401 | pass |
| 144 | E share link | share links in the database after all attempts (read-only) | `share` | read-only SQL | 0 | 0 | pass |
| 145 | E share link | tenant A: its key still reads its website | `GET /api/websites/5758992c-5c95-482b-bbd0-ebd19b782c7f/stats` | A key | 200 | 200 | pass |
| 146 | F1 own data | A key reads A | `GET /api/websites/:id` | A key | 200 | 200 | pass |
| 147 | F1 own data | B key reads B | `GET /api/websites/:id` | B key | 200 | 200 | pass |
| 148 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id` | A key | 401 | 401 | pass |
| 149 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id` | B key | 401 | 401 | pass |
| 150 | F1 own data | A key reads A | `GET /api/websites/:id/active` | A key | 200 | 200 | pass |
| 151 | F1 own data | B key reads B | `GET /api/websites/:id/active` | B key | 200 | 200 | pass |
| 152 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/active` | A key | 401 | 401 | pass |
| 153 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/active` | B key | 401 | 401 | pass |
| 154 | F1 own data | A key reads A | `GET /api/websites/:id/daterange` | A key | 200 | 200 | pass |
| 155 | F1 own data | B key reads B | `GET /api/websites/:id/daterange` | B key | 200 | 200 | pass |
| 156 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/daterange` | A key | 401 | 401 | pass |
| 157 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/daterange` | B key | 401 | 401 | pass |
| 158 | F1 own data | A key reads A | `GET /api/websites/:id/stats` | A key | 200 | 200 | pass |
| 159 | F1 own data | B key reads B | `GET /api/websites/:id/stats` | B key | 200 | 200 | pass |
| 160 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/stats` | A key | 401 | 401 | pass |
| 161 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/stats` | B key | 401 | 401 | pass |
| 162 | F1 own data | A key reads A | `GET /api/websites/:id/pageviews` | A key | 200 | 200 | pass |
| 163 | F1 own data | B key reads B | `GET /api/websites/:id/pageviews` | B key | 200 | 200 | pass |
| 164 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/pageviews` | A key | 401 | 401 | pass |
| 165 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/pageviews` | B key | 401 | 401 | pass |
| 166 | F1 own data | A key reads A | `GET /api/websites/:id/metrics` | A key | 200 | 200 | pass |
| 167 | F1 own data | B key reads B | `GET /api/websites/:id/metrics` | B key | 200 | 200 | pass |
| 168 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/metrics` | A key | 401 | 401 | pass |
| 169 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/metrics` | B key | 401 | 401 | pass |
| 170 | F1 own data | A key reads A | `GET /api/websites/:id/metrics/expanded` | A key | 200 | 200 | pass |
| 171 | F1 own data | B key reads B | `GET /api/websites/:id/metrics/expanded` | B key | 200 | 200 | pass |
| 172 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/metrics/expanded` | A key | 401 | 401 | pass |
| 173 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/metrics/expanded` | B key | 401 | 401 | pass |
| 174 | F1 own data | A key reads A | `GET /api/websites/:id/values` | A key | 200 | 200 | pass |
| 175 | F1 own data | B key reads B | `GET /api/websites/:id/values` | B key | 200 | 200 | pass |
| 176 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/values` | A key | 401 | 401 | pass |
| 177 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/values` | B key | 401 | 401 | pass |
| 178 | F1 own data | A key reads A | `GET /api/websites/:id/sessions` | A key | 200 | 200 | pass |
| 179 | F1 own data | B key reads B | `GET /api/websites/:id/sessions` | B key | 200 | 200 | pass |
| 180 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/sessions` | A key | 401 | 401 | pass |
| 181 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/sessions` | B key | 401 | 401 | pass |
| 182 | F1 own data | A key reads A | `GET /api/websites/:id/sessions/stats` | A key | 200 | 200 | pass |
| 183 | F1 own data | B key reads B | `GET /api/websites/:id/sessions/stats` | B key | 200 | 200 | pass |
| 184 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/sessions/stats` | A key | 401 | 401 | pass |
| 185 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/sessions/stats` | B key | 401 | 401 | pass |
| 186 | F1 own data | A key reads A | `GET /api/websites/:id/sessions/weekly` | A key | 200 | 200 | pass |
| 187 | F1 own data | B key reads B | `GET /api/websites/:id/sessions/weekly` | B key | 200 | 200 | pass |
| 188 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/sessions/weekly` | A key | 401 | 401 | pass |
| 189 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/sessions/weekly` | B key | 401 | 401 | pass |
| 190 | F1 own data | A key reads A | `GET /api/websites/:id/session-data/properties` | A key | 200 | 200 | pass |
| 191 | F1 own data | B key reads B | `GET /api/websites/:id/session-data/properties` | B key | 200 | 200 | pass |
| 192 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/session-data/properties` | A key | 401 | 401 | pass |
| 193 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/session-data/properties` | B key | 401 | 401 | pass |
| 194 | F1 own data | A key reads A | `GET /api/websites/:id/session-data/values` | A key | 200 | 200 | pass |
| 195 | F1 own data | B key reads B | `GET /api/websites/:id/session-data/values` | B key | 200 | 200 | pass |
| 196 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/session-data/values` | A key | 401 | 401 | pass |
| 197 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/session-data/values` | B key | 401 | 401 | pass |
| 198 | F1 own data | A key reads A | `GET /api/websites/:id/session-data/stats` | A key | 200 | 200 | pass |
| 199 | F1 own data | B key reads B | `GET /api/websites/:id/session-data/stats` | B key | 200 | 200 | pass |
| 200 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/session-data/stats` | A key | 401 | 401 | pass |
| 201 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/session-data/stats` | B key | 401 | 401 | pass |
| 202 | F1 own data | A key reads A | `GET /api/websites/:id/session-data/array-series` | A key | 200 | 200 | pass |
| 203 | F1 own data | B key reads B | `GET /api/websites/:id/session-data/array-series` | B key | 200 | 200 | pass |
| 204 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/session-data/array-series` | A key | 401 | 401 | pass |
| 205 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/session-data/array-series` | B key | 401 | 401 | pass |
| 206 | F1 own data | A key reads A | `GET /api/websites/:id/session-data/date-series` | A key | 200 | 200 | pass |
| 207 | F1 own data | B key reads B | `GET /api/websites/:id/session-data/date-series` | B key | 200 | 200 | pass |
| 208 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/session-data/date-series` | A key | 401 | 401 | pass |
| 209 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/session-data/date-series` | B key | 401 | 401 | pass |
| 210 | F1 own data | A key reads A | `GET /api/websites/:id/session-data/numeric-series` | A key | 200 | 200 | pass |
| 211 | F1 own data | B key reads B | `GET /api/websites/:id/session-data/numeric-series` | B key | 200 | 200 | pass |
| 212 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/session-data/numeric-series` | A key | 401 | 401 | pass |
| 213 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/session-data/numeric-series` | B key | 401 | 401 | pass |
| 214 | F1 own data | A key reads A | `GET /api/websites/:id/session-data/numeric-stats` | A key | 200 | 200 | pass |
| 215 | F1 own data | B key reads B | `GET /api/websites/:id/session-data/numeric-stats` | B key | 200 | 200 | pass |
| 216 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/session-data/numeric-stats` | A key | 401 | 401 | pass |
| 217 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/session-data/numeric-stats` | B key | 401 | 401 | pass |
| 218 | F1 own data | A key reads A | `GET /api/websites/:id/session-data/property-series` | A key | 200 | 200 | pass |
| 219 | F1 own data | B key reads B | `GET /api/websites/:id/session-data/property-series` | B key | 200 | 200 | pass |
| 220 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/session-data/property-series` | A key | 401 | 401 | pass |
| 221 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/session-data/property-series` | B key | 401 | 401 | pass |
| 222 | F1 own data | A key reads A | `GET /api/websites/:id/session-data-pivot` | A key | 200 | 200 | pass |
| 223 | F1 own data | B key reads B | `GET /api/websites/:id/session-data-pivot` | B key | 200 | 200 | pass |
| 224 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/session-data-pivot` | A key | 401 | 401 | pass |
| 225 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/session-data-pivot` | B key | 401 | 401 | pass |
| 226 | F1 own data | A key reads A | `GET /api/websites/:id/events` | A key | 200 | 200 | pass |
| 227 | F1 own data | B key reads B | `GET /api/websites/:id/events` | B key | 200 | 200 | pass |
| 228 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/events` | A key | 401 | 401 | pass |
| 229 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/events` | B key | 401 | 401 | pass |
| 230 | F1 own data | A key reads A | `GET /api/websites/:id/events/series` | A key | 200 | 200 | pass |
| 231 | F1 own data | B key reads B | `GET /api/websites/:id/events/series` | B key | 200 | 200 | pass |
| 232 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/events/series` | A key | 401 | 401 | pass |
| 233 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/events/series` | B key | 401 | 401 | pass |
| 234 | F1 own data | A key reads A | `GET /api/websites/:id/events/stats` | A key | 200 | 200 | pass |
| 235 | F1 own data | B key reads B | `GET /api/websites/:id/events/stats` | B key | 200 | 200 | pass |
| 236 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/events/stats` | A key | 401 | 401 | pass |
| 237 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/events/stats` | B key | 401 | 401 | pass |
| 238 | F1 own data | A key reads A | `GET /api/websites/:id/event-data` | A key | 200 | 200 | pass |
| 239 | F1 own data | B key reads B | `GET /api/websites/:id/event-data` | B key | 200 | 200 | pass |
| 240 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/event-data` | A key | 401 | 401 | pass |
| 241 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/event-data` | B key | 401 | 401 | pass |
| 242 | F1 own data | A key reads A | `GET /api/websites/:id/event-data/events` | A key | 200 | 200 | pass |
| 243 | F1 own data | B key reads B | `GET /api/websites/:id/event-data/events` | B key | 200 | 200 | pass |
| 244 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/event-data/events` | A key | 401 | 401 | pass |
| 245 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/event-data/events` | B key | 401 | 401 | pass |
| 246 | F1 own data | A key reads A | `GET /api/websites/:id/event-data/fields` | A key | 200 | 200 | pass |
| 247 | F1 own data | B key reads B | `GET /api/websites/:id/event-data/fields` | B key | 200 | 200 | pass |
| 248 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/event-data/fields` | A key | 401 | 401 | pass |
| 249 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/event-data/fields` | B key | 401 | 401 | pass |
| 250 | F1 own data | A key reads A | `GET /api/websites/:id/event-data/properties` | A key | 200 | 200 | pass |
| 251 | F1 own data | B key reads B | `GET /api/websites/:id/event-data/properties` | B key | 200 | 200 | pass |
| 252 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/event-data/properties` | A key | 401 | 401 | pass |
| 253 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/event-data/properties` | B key | 401 | 401 | pass |
| 254 | F1 own data | A key reads A | `GET /api/websites/:id/event-data/stats` | A key | 200 | 200 | pass |
| 255 | F1 own data | B key reads B | `GET /api/websites/:id/event-data/stats` | B key | 200 | 200 | pass |
| 256 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/event-data/stats` | A key | 401 | 401 | pass |
| 257 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/event-data/stats` | B key | 401 | 401 | pass |
| 258 | F1 own data | A key reads A | `GET /api/websites/:id/event-data/values` | A key | 200 | 200 | pass |
| 259 | F1 own data | B key reads B | `GET /api/websites/:id/event-data/values` | B key | 200 | 200 | pass |
| 260 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/event-data/values` | A key | 401 | 401 | pass |
| 261 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/event-data/values` | B key | 401 | 401 | pass |
| 262 | F1 own data | A key reads A | `GET /api/websites/:id/event-data-pivot` | A key | 200 | 200 | pass |
| 263 | F1 own data | B key reads B | `GET /api/websites/:id/event-data-pivot` | B key | 200 | 200 | pass |
| 264 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/event-data-pivot` | A key | 401 | 401 | pass |
| 265 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/event-data-pivot` | B key | 401 | 401 | pass |
| 266 | F1 own data | A key reads A | `GET /api/websites/:id/event-data-pivot/array-series` | A key | 200 | 200 | pass |
| 267 | F1 own data | B key reads B | `GET /api/websites/:id/event-data-pivot/array-series` | B key | 200 | 200 | pass |
| 268 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/event-data-pivot/array-series` | A key | 401 | 401 | pass |
| 269 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/event-data-pivot/array-series` | B key | 401 | 401 | pass |
| 270 | F1 own data | A key reads A | `GET /api/websites/:id/event-data-pivot/date-series` | A key | 200 | 200 | pass |
| 271 | F1 own data | B key reads B | `GET /api/websites/:id/event-data-pivot/date-series` | B key | 200 | 200 | pass |
| 272 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/event-data-pivot/date-series` | A key | 401 | 401 | pass |
| 273 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/event-data-pivot/date-series` | B key | 401 | 401 | pass |
| 274 | F1 own data | A key reads A | `GET /api/websites/:id/event-data-pivot/numeric-series` | A key | 200 | 200 | pass |
| 275 | F1 own data | B key reads B | `GET /api/websites/:id/event-data-pivot/numeric-series` | B key | 200 | 200 | pass |
| 276 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/event-data-pivot/numeric-series` | A key | 401 | 401 | pass |
| 277 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/event-data-pivot/numeric-series` | B key | 401 | 401 | pass |
| 278 | F1 own data | A key reads A | `GET /api/websites/:id/event-data-pivot/numeric-stats` | A key | 200 | 200 | pass |
| 279 | F1 own data | B key reads B | `GET /api/websites/:id/event-data-pivot/numeric-stats` | B key | 200 | 200 | pass |
| 280 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/event-data-pivot/numeric-stats` | A key | 401 | 401 | pass |
| 281 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/event-data-pivot/numeric-stats` | B key | 401 | 401 | pass |
| 282 | F1 own data | A key reads A | `GET /api/websites/:id/event-data-pivot/property-series` | A key | 200 | 200 | pass |
| 283 | F1 own data | B key reads B | `GET /api/websites/:id/event-data-pivot/property-series` | B key | 200 | 200 | pass |
| 284 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/event-data-pivot/property-series` | A key | 401 | 401 | pass |
| 285 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/event-data-pivot/property-series` | B key | 401 | 401 | pass |
| 286 | F1 own data | A key reads A | `GET /api/websites/:id/funnels` | A key | 200 | 200 | pass |
| 287 | F1 own data | B key reads B | `GET /api/websites/:id/funnels` | B key | 200 | 200 | pass |
| 288 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/funnels` | A key | 401 | 401 | pass |
| 289 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/funnels` | B key | 401 | 401 | pass |
| 290 | F1 own data | A key reads A | `GET /api/websites/:id/funnels/stats` | A key | 200 | 200 | pass |
| 291 | F1 own data | B key reads B | `GET /api/websites/:id/funnels/stats` | B key | 200 | 200 | pass |
| 292 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/funnels/stats` | A key | 401 | 401 | pass |
| 293 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/funnels/stats` | B key | 401 | 401 | pass |
| 294 | F1 own data | A key reads A | `GET /api/websites/:id/goals` | A key | 200 | 200 | pass |
| 295 | F1 own data | B key reads B | `GET /api/websites/:id/goals` | B key | 200 | 200 | pass |
| 296 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/goals` | A key | 401 | 401 | pass |
| 297 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/goals` | B key | 401 | 401 | pass |
| 298 | F1 own data | A key reads A | `GET /api/websites/:id/goals/stats` | A key | 200 | 200 | pass |
| 299 | F1 own data | B key reads B | `GET /api/websites/:id/goals/stats` | B key | 200 | 200 | pass |
| 300 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/goals/stats` | A key | 401 | 401 | pass |
| 301 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/goals/stats` | B key | 401 | 401 | pass |
| 302 | F1 own data | A key reads A | `GET /api/websites/:id/journeys` | A key | 200 | 200 | pass |
| 303 | F1 own data | B key reads B | `GET /api/websites/:id/journeys` | B key | 200 | 200 | pass |
| 304 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/journeys` | A key | 401 | 401 | pass |
| 305 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/journeys` | B key | 401 | 401 | pass |
| 306 | F1 own data | A key reads A | `GET /api/websites/:id/retention` | A key | 200 | 200 | pass |
| 307 | F1 own data | B key reads B | `GET /api/websites/:id/retention` | B key | 200 | 200 | pass |
| 308 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/retention` | A key | 401 | 401 | pass |
| 309 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/retention` | B key | 401 | 401 | pass |
| 310 | F1 own data | A key reads A | `GET /api/websites/:id/attribution` | A key | 200 | 200 | pass |
| 311 | F1 own data | B key reads B | `GET /api/websites/:id/attribution` | B key | 200 | 200 | pass |
| 312 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/attribution` | A key | 401 | 401 | pass |
| 313 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/attribution` | B key | 401 | 401 | pass |
| 314 | F1 own data | A key reads A | `GET /api/websites/:id/breakdown` | A key | 200 | 200 | pass |
| 315 | F1 own data | B key reads B | `GET /api/websites/:id/breakdown` | B key | 200 | 200 | pass |
| 316 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/breakdown` | A key | 401 | 401 | pass |
| 317 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/breakdown` | B key | 401 | 401 | pass |
| 318 | F1 own data | A key reads A | `GET /api/websites/:id/utm/metrics` | A key | 200 | 200 | pass |
| 319 | F1 own data | B key reads B | `GET /api/websites/:id/utm/metrics` | B key | 200 | 200 | pass |
| 320 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/utm/metrics` | A key | 401 | 401 | pass |
| 321 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/utm/metrics` | B key | 401 | 401 | pass |
| 322 | F1 own data | A key reads A | `GET /api/websites/:id/revenue/stats` | A key | 200 | 200 | pass |
| 323 | F1 own data | B key reads B | `GET /api/websites/:id/revenue/stats` | B key | 200 | 200 | pass |
| 324 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/revenue/stats` | A key | 401 | 401 | pass |
| 325 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/revenue/stats` | B key | 401 | 401 | pass |
| 326 | F1 own data | A key reads A | `GET /api/websites/:id/revenue/chart` | A key | 200 | 200 | pass |
| 327 | F1 own data | B key reads B | `GET /api/websites/:id/revenue/chart` | B key | 200 | 200 | pass |
| 328 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/revenue/chart` | A key | 401 | 401 | pass |
| 329 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/revenue/chart` | B key | 401 | 401 | pass |
| 330 | F1 own data | A key reads A | `GET /api/websites/:id/revenue/metrics` | A key | 200 | 200 | pass |
| 331 | F1 own data | B key reads B | `GET /api/websites/:id/revenue/metrics` | B key | 200 | 200 | pass |
| 332 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/revenue/metrics` | A key | 401 | 401 | pass |
| 333 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/revenue/metrics` | B key | 401 | 401 | pass |
| 334 | F1 own data | A key reads A | `GET /api/websites/:id/revenue/sessions` | A key | 200 | 200 | pass |
| 335 | F1 own data | B key reads B | `GET /api/websites/:id/revenue/sessions` | B key | 200 | 200 | pass |
| 336 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/revenue/sessions` | A key | 401 | 401 | pass |
| 337 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/revenue/sessions` | B key | 401 | 401 | pass |
| 338 | F1 own data | A key reads A | `GET /api/websites/:id/performance/stats` | A key | 200 | 200 | pass |
| 339 | F1 own data | B key reads B | `GET /api/websites/:id/performance/stats` | B key | 200 | 200 | pass |
| 340 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/performance/stats` | A key | 401 | 401 | pass |
| 341 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/performance/stats` | B key | 401 | 401 | pass |
| 342 | F1 own data | A key reads A | `GET /api/websites/:id/performance/chart` | A key | 200 | 200 | pass |
| 343 | F1 own data | B key reads B | `GET /api/websites/:id/performance/chart` | B key | 200 | 200 | pass |
| 344 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/performance/chart` | A key | 401 | 401 | pass |
| 345 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/performance/chart` | B key | 401 | 401 | pass |
| 346 | F1 own data | A key reads A | `GET /api/websites/:id/performance/metrics` | A key | 200 | 200 | pass |
| 347 | F1 own data | B key reads B | `GET /api/websites/:id/performance/metrics` | B key | 200 | 200 | pass |
| 348 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/performance/metrics` | A key | 401 | 401 | pass |
| 349 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/performance/metrics` | B key | 401 | 401 | pass |
| 350 | F1 own data | A key reads A | `GET /api/websites/:id/errors` | A key | 200 | 200 | pass |
| 351 | F1 own data | B key reads B | `GET /api/websites/:id/errors` | B key | 200 | 200 | pass |
| 352 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/errors` | A key | 401 | 401 | pass |
| 353 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/errors` | B key | 401 | 401 | pass |
| 354 | F1 own data | A key reads A | `GET /api/websites/:id/errors/stats` | A key | 200 | 200 | pass |
| 355 | F1 own data | B key reads B | `GET /api/websites/:id/errors/stats` | B key | 200 | 200 | pass |
| 356 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/errors/stats` | A key | 401 | 401 | pass |
| 357 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/errors/stats` | B key | 401 | 401 | pass |
| 358 | F1 own data | A key reads A | `GET /api/websites/:id/errors/values` | A key | 200 | 200 | pass |
| 359 | F1 own data | B key reads B | `GET /api/websites/:id/errors/values` | B key | 200 | 200 | pass |
| 360 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/errors/values` | A key | 401 | 401 | pass |
| 361 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/errors/values` | B key | 401 | 401 | pass |
| 362 | F1 own data | A key reads A | `GET /api/websites/:id/heatmaps` | A key | 200 | 200 | pass |
| 363 | F1 own data | B key reads B | `GET /api/websites/:id/heatmaps` | B key | 200 | 200 | pass |
| 364 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/heatmaps` | A key | 401 | 401 | pass |
| 365 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/heatmaps` | B key | 401 | 401 | pass |
| 366 | F1 own data | A key reads A | `GET /api/websites/:id/replays` | A key | 200 | 200 | pass |
| 367 | F1 own data | B key reads B | `GET /api/websites/:id/replays` | B key | 200 | 200 | pass |
| 368 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/replays` | A key | 401 | 401 | pass |
| 369 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/replays` | B key | 401 | 401 | pass |
| 370 | F1 own data | A key reads A | `GET /api/websites/:id/replays/saved` | A key | 200 | 200 | pass |
| 371 | F1 own data | B key reads B | `GET /api/websites/:id/replays/saved` | B key | 200 | 200 | pass |
| 372 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/replays/saved` | A key | 401 | 401 | pass |
| 373 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/replays/saved` | B key | 401 | 401 | pass |
| 374 | F1 own data | A key reads A | `GET /api/websites/:id/export` | A key | 200 | 200 | pass |
| 375 | F1 own data | B key reads B | `GET /api/websites/:id/export` | B key | 200 | 200 | pass |
| 376 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/export` | A key | 401 | 401 | pass |
| 377 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/export` | B key | 401 | 401 | pass |
| 378 | F1 own data | A key reads A | `GET /api/websites/:id/segments` | A key | 200 | 200 | pass |
| 379 | F1 own data | B key reads B | `GET /api/websites/:id/segments` | B key | 200 | 200 | pass |
| 380 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/segments` | A key | 401 | 401 | pass |
| 381 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/segments` | B key | 401 | 401 | pass |
| 382 | F1 own data | A key reads A | `GET /api/websites/:id/annotations` | A key | 200 | 200 | pass |
| 383 | F1 own data | B key reads B | `GET /api/websites/:id/annotations` | B key | 200 | 200 | pass |
| 384 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/annotations` | A key | 401 | 401 | pass |
| 385 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/annotations` | B key | 401 | 401 | pass |
| 386 | F1 own data | A key reads A | `GET /api/websites/:id/shares` | A key | 200 | 200 | pass |
| 387 | F1 own data | B key reads B | `GET /api/websites/:id/shares` | B key | 200 | 200 | pass |
| 388 | F2 cross-tenant read | A key reads B | `GET /api/websites/:id/shares` | A key | 401 | 401 | pass |
| 389 | F2 cross-tenant read | B key reads A | `GET /api/websites/:id/shares` | B key | 401 | 401 | pass |
| 390 | F1 own data | A key reads A (stored object) | `GET /api/websites/:id/sessions/:sessionId` | A key | 200 | 200 | pass |
| 391 | F1 own data | B key reads B (stored object) | `GET /api/websites/:id/sessions/:sessionId` | B key | 200 | 200 | pass |
| 392 | F2 cross-tenant read | A key reads B (stored object) | `GET /api/websites/:id/sessions/:sessionId` | A key | 401 | 401 | pass |
| 393 | F2 cross-tenant read | B key reads A (stored object) | `GET /api/websites/:id/sessions/:sessionId` | B key | 401 | 401 | pass |
| 394 | F2 cross-tenant read | A key, A website, B object id | `GET /api/websites/:id/sessions/:sessionId` | A key | 404 no B data | 404 no B data | pass |
| 395 | F1 own data | A key reads A (stored object) | `GET /api/websites/:id/sessions/:sessionId/activity` | A key | 200 | 200 | pass |
| 396 | F1 own data | B key reads B (stored object) | `GET /api/websites/:id/sessions/:sessionId/activity` | B key | 200 | 200 | pass |
| 397 | F2 cross-tenant read | A key reads B (stored object) | `GET /api/websites/:id/sessions/:sessionId/activity` | A key | 401 | 401 | pass |
| 398 | F2 cross-tenant read | B key reads A (stored object) | `GET /api/websites/:id/sessions/:sessionId/activity` | B key | 401 | 401 | pass |
| 399 | F2 cross-tenant read | A key, A website, B object id | `GET /api/websites/:id/sessions/:sessionId/activity` | A key | 200 no B data | 200 no B data | pass |
| 400 | F1 own data | A key reads A (stored object) | `GET /api/websites/:id/sessions/:sessionId/properties` | A key | 200 | 200 | pass |
| 401 | F1 own data | B key reads B (stored object) | `GET /api/websites/:id/sessions/:sessionId/properties` | B key | 200 | 200 | pass |
| 402 | F2 cross-tenant read | A key reads B (stored object) | `GET /api/websites/:id/sessions/:sessionId/properties` | A key | 401 | 401 | pass |
| 403 | F2 cross-tenant read | B key reads A (stored object) | `GET /api/websites/:id/sessions/:sessionId/properties` | B key | 401 | 401 | pass |
| 404 | F2 cross-tenant read | A key, A website, B object id | `GET /api/websites/:id/sessions/:sessionId/properties` | A key | 200 no B data | 200 no B data | pass |
| 405 | F1 own data | A key reads A (stored object) | `GET /api/websites/:id/sessions/:sessionId/replays` | A key | 200 | 200 | pass |
| 406 | F1 own data | B key reads B (stored object) | `GET /api/websites/:id/sessions/:sessionId/replays` | B key | 200 | 200 | pass |
| 407 | F2 cross-tenant read | A key reads B (stored object) | `GET /api/websites/:id/sessions/:sessionId/replays` | A key | 401 | 401 | pass |
| 408 | F2 cross-tenant read | B key reads A (stored object) | `GET /api/websites/:id/sessions/:sessionId/replays` | B key | 401 | 401 | pass |
| 409 | F2 cross-tenant read | A key, A website, B object id | `GET /api/websites/:id/sessions/:sessionId/replays` | A key | 200 no B data | 200 no B data | pass |
| 410 | F1 own data | A key reads A (stored object) | `GET /api/websites/:id/event-data/:eventId` | A key | 200 | 200 | pass |
| 411 | F1 own data | B key reads B (stored object) | `GET /api/websites/:id/event-data/:eventId` | B key | 200 | 200 | pass |
| 412 | F2 cross-tenant read | A key reads B (stored object) | `GET /api/websites/:id/event-data/:eventId` | A key | 401 | 401 | pass |
| 413 | F2 cross-tenant read | B key reads A (stored object) | `GET /api/websites/:id/event-data/:eventId` | B key | 401 | 401 | pass |
| 414 | F2 cross-tenant read | A key, A website, B object id | `GET /api/websites/:id/event-data/:eventId` | A key | 200 no B data | 200 no B data | pass |
| 415 | F1 own data | A key reads A (stored object) | `GET /api/websites/:id/annotations/:annotationId` | A key | 200 | 200 | pass |
| 416 | F1 own data | B key reads B (stored object) | `GET /api/websites/:id/annotations/:annotationId` | B key | 200 | 200 | pass |
| 417 | F2 cross-tenant read | A key reads B (stored object) | `GET /api/websites/:id/annotations/:annotationId` | A key | 401 | 401 | pass |
| 418 | F2 cross-tenant read | B key reads A (stored object) | `GET /api/websites/:id/annotations/:annotationId` | B key | 401 | 401 | pass |
| 419 | F2 cross-tenant read | A key, A website, B object id | `GET /api/websites/:id/annotations/:annotationId` | A key | 404 no B data | 404 no B data | pass |
| 420 | F1 own data | A key reads A (stored object) | `GET /api/websites/:id/segments/:segmentId` | A key | 200 | 200 | pass |
| 421 | F1 own data | B key reads B (stored object) | `GET /api/websites/:id/segments/:segmentId` | B key | 200 | 200 | pass |
| 422 | F2 cross-tenant read | A key reads B (stored object) | `GET /api/websites/:id/segments/:segmentId` | A key | 401 | 401 | pass |
| 423 | F2 cross-tenant read | B key reads A (stored object) | `GET /api/websites/:id/segments/:segmentId` | B key | 401 | 401 | pass |
| 424 | F2 cross-tenant read | A key, A website, B object id | `GET /api/websites/:id/segments/:segmentId` | A key | 404 no B data | 404 no B data | pass |
| 425 | F1 own data | A key reads A (stored object) | `GET /api/websites/:id/funnels/:funnelId` | A key | 200 | 200 | pass |
| 426 | F1 own data | B key reads B (stored object) | `GET /api/websites/:id/funnels/:funnelId` | B key | 200 | 200 | pass |
| 427 | F2 cross-tenant read | A key reads B (stored object) | `GET /api/websites/:id/funnels/:funnelId` | A key | 401 | 401 | pass |
| 428 | F2 cross-tenant read | B key reads A (stored object) | `GET /api/websites/:id/funnels/:funnelId` | B key | 401 | 401 | pass |
| 429 | F2 cross-tenant read | A key, A website, B object id | `GET /api/websites/:id/funnels/:funnelId` | A key | 404 no B data | 404 no B data | pass |
| 430 | F1 own data | A key reads A (stored object) | `GET /api/websites/:id/funnels/:funnelId/stats` | A key | 200 | 200 | pass |
| 431 | F1 own data | B key reads B (stored object) | `GET /api/websites/:id/funnels/:funnelId/stats` | B key | 200 | 200 | pass |
| 432 | F2 cross-tenant read | A key reads B (stored object) | `GET /api/websites/:id/funnels/:funnelId/stats` | A key | 401 | 401 | pass |
| 433 | F2 cross-tenant read | B key reads A (stored object) | `GET /api/websites/:id/funnels/:funnelId/stats` | B key | 401 | 401 | pass |
| 434 | F2 cross-tenant read | A key, A website, B object id | `GET /api/websites/:id/funnels/:funnelId/stats` | A key | 404 no B data | 404 no B data | pass |
| 435 | F1 own data | A key reads A (stored object) | `GET /api/websites/:id/goals/:goalId` | A key | 200 | 200 | pass |
| 436 | F1 own data | B key reads B (stored object) | `GET /api/websites/:id/goals/:goalId` | B key | 200 | 200 | pass |
| 437 | F2 cross-tenant read | A key reads B (stored object) | `GET /api/websites/:id/goals/:goalId` | A key | 401 | 401 | pass |
| 438 | F2 cross-tenant read | B key reads A (stored object) | `GET /api/websites/:id/goals/:goalId` | B key | 401 | 401 | pass |
| 439 | F2 cross-tenant read | A key, A website, B object id | `GET /api/websites/:id/goals/:goalId` | A key | 404 no B data | 404 no B data | pass |
| 440 | F1 own data | A key reads A (stored object) | `GET /api/websites/:id/goals/:goalId/stats` | A key | 200 | 200 | pass |
| 441 | F1 own data | B key reads B (stored object) | `GET /api/websites/:id/goals/:goalId/stats` | B key | 200 | 200 | pass |
| 442 | F2 cross-tenant read | A key reads B (stored object) | `GET /api/websites/:id/goals/:goalId/stats` | A key | 401 | 401 | pass |
| 443 | F2 cross-tenant read | B key reads A (stored object) | `GET /api/websites/:id/goals/:goalId/stats` | B key | 401 | 401 | pass |
| 444 | F2 cross-tenant read | A key, A website, B object id | `GET /api/websites/:id/goals/:goalId/stats` | A key | 404 no B data | 404 no B data | pass |
| 445 | F1 own data | A key reads A (no stored object, guard only) | `GET /api/websites/:id/errors/:issueId` | A key | 404 | 404 | pass |
| 446 | F1 own data | B key reads B (no stored object, guard only) | `GET /api/websites/:id/errors/:issueId` | B key | 404 | 404 | pass |
| 447 | F2 cross-tenant read | A key reads B (no stored object, guard only) | `GET /api/websites/:id/errors/:issueId` | A key | 401 | 401 | pass |
| 448 | F2 cross-tenant read | B key reads A (no stored object, guard only) | `GET /api/websites/:id/errors/:issueId` | B key | 401 | 401 | pass |
| 449 | F1 own data | A key reads A (no stored object, guard only) | `GET /api/websites/:id/errors/:issueId/events` | A key | 404 | 404 | pass |
| 450 | F1 own data | B key reads B (no stored object, guard only) | `GET /api/websites/:id/errors/:issueId/events` | B key | 404 | 404 | pass |
| 451 | F2 cross-tenant read | A key reads B (no stored object, guard only) | `GET /api/websites/:id/errors/:issueId/events` | A key | 401 | 401 | pass |
| 452 | F2 cross-tenant read | B key reads A (no stored object, guard only) | `GET /api/websites/:id/errors/:issueId/events` | B key | 401 | 401 | pass |
| 453 | F1 own data | A key reads A (no stored object, guard only) | `GET /api/websites/:id/errors/:issueId/values` | A key | 404 | 404 | pass |
| 454 | F1 own data | B key reads B (no stored object, guard only) | `GET /api/websites/:id/errors/:issueId/values` | B key | 404 | 404 | pass |
| 455 | F2 cross-tenant read | A key reads B (no stored object, guard only) | `GET /api/websites/:id/errors/:issueId/values` | A key | 401 | 401 | pass |
| 456 | F2 cross-tenant read | B key reads A (no stored object, guard only) | `GET /api/websites/:id/errors/:issueId/values` | B key | 401 | 401 | pass |
| 457 | F1 own data | A key reads A (no stored object, guard only) | `GET /api/websites/:id/errors/:issueId/events/:eventId` | A key | 404 | 404 | pass |
| 458 | F1 own data | B key reads B (no stored object, guard only) | `GET /api/websites/:id/errors/:issueId/events/:eventId` | B key | 404 | 404 | pass |
| 459 | F2 cross-tenant read | A key reads B (no stored object, guard only) | `GET /api/websites/:id/errors/:issueId/events/:eventId` | A key | 401 | 401 | pass |
| 460 | F2 cross-tenant read | B key reads A (no stored object, guard only) | `GET /api/websites/:id/errors/:issueId/events/:eventId` | B key | 401 | 401 | pass |
| 461 | F1 own data | A key reads A (no stored object, guard only) | `GET /api/websites/:id/replays/:replayId` | A key | 200 | 200 | pass |
| 462 | F1 own data | B key reads B (no stored object, guard only) | `GET /api/websites/:id/replays/:replayId` | B key | 200 | 200 | pass |
| 463 | F2 cross-tenant read | A key reads B (no stored object, guard only) | `GET /api/websites/:id/replays/:replayId` | A key | 401 | 401 | pass |
| 464 | F2 cross-tenant read | B key reads A (no stored object, guard only) | `GET /api/websites/:id/replays/:replayId` | B key | 401 | 401 | pass |
| 465 | F1 own data | A key reads A (no stored object, guard only) | `GET /api/websites/:id/replays/saved/:replayId` | A key | 200 | 200 | pass |
| 466 | F1 own data | B key reads B (no stored object, guard only) | `GET /api/websites/:id/replays/saved/:replayId` | B key | 200 | 200 | pass |
| 467 | F2 cross-tenant read | A key reads B (no stored object, guard only) | `GET /api/websites/:id/replays/saved/:replayId` | A key | 401 | 401 | pass |
| 468 | F2 cross-tenant read | B key reads A (no stored object, guard only) | `GET /api/websites/:id/replays/saved/:replayId` | B key | 401 | 401 | pass |
| 469 | F1 own data | A key reads A | `GET /api/realtime/[websiteId]` | A key | 200 | 200 | pass |
| 470 | F1 own data | B key reads B | `GET /api/realtime/[websiteId]` | B key | 200 | 200 | pass |
| 471 | F2 cross-tenant read | A key reads B | `GET /api/realtime/[websiteId]` | A key | 401 | 401 | pass |
| 472 | F2 cross-tenant read | B key reads A | `GET /api/realtime/[websiteId]` | B key | 401 | 401 | pass |
| 473 | F1 own data | A key reads A | `GET /api/teams/[teamId]` | A key | 200 | 200 | pass |
| 474 | F1 own data | B key reads B | `GET /api/teams/[teamId]` | B key | 200 | 200 | pass |
| 475 | F2 cross-tenant read | A key reads B | `GET /api/teams/[teamId]` | A key | 401 | 401 | pass |
| 476 | F2 cross-tenant read | B key reads A | `GET /api/teams/[teamId]` | B key | 401 | 401 | pass |
| 477 | F1 own data | A key reads A | `GET /api/teams/[teamId]/users` | A key | 200 | 200 | pass |
| 478 | F1 own data | B key reads B | `GET /api/teams/[teamId]/users` | B key | 200 | 200 | pass |
| 479 | F2 cross-tenant read | A key reads B | `GET /api/teams/[teamId]/users` | A key | 401 | 401 | pass |
| 480 | F2 cross-tenant read | B key reads A | `GET /api/teams/[teamId]/users` | B key | 401 | 401 | pass |
| 481 | F1 own data | A key reads A | `GET /api/teams/[teamId]/websites` | A key | 200 | 200 | pass |
| 482 | F1 own data | B key reads B | `GET /api/teams/[teamId]/websites` | B key | 200 | 200 | pass |
| 483 | F2 cross-tenant read | A key reads B | `GET /api/teams/[teamId]/websites` | A key | 401 | 401 | pass |
| 484 | F2 cross-tenant read | B key reads A | `GET /api/teams/[teamId]/websites` | B key | 401 | 401 | pass |
| 485 | F1 own data | A key reads A | `GET /api/teams/[teamId]/boards` | A key | 200 | 200 | pass |
| 486 | F1 own data | B key reads B | `GET /api/teams/[teamId]/boards` | B key | 200 | 200 | pass |
| 487 | F2 cross-tenant read | A key reads B | `GET /api/teams/[teamId]/boards` | A key | 401 | 401 | pass |
| 488 | F2 cross-tenant read | B key reads A | `GET /api/teams/[teamId]/boards` | B key | 401 | 401 | pass |
| 489 | F1 own data | A key reads A | `GET /api/teams/[teamId]/links` | A key | 200 | 200 | pass |
| 490 | F1 own data | B key reads B | `GET /api/teams/[teamId]/links` | B key | 200 | 200 | pass |
| 491 | F2 cross-tenant read | A key reads B | `GET /api/teams/[teamId]/links` | A key | 401 | 401 | pass |
| 492 | F2 cross-tenant read | B key reads A | `GET /api/teams/[teamId]/links` | B key | 401 | 401 | pass |
| 493 | F1 own data | A key reads A | `GET /api/teams/[teamId]/pixels` | A key | 200 | 200 | pass |
| 494 | F1 own data | B key reads B | `GET /api/teams/[teamId]/pixels` | B key | 200 | 200 | pass |
| 495 | F2 cross-tenant read | A key reads B | `GET /api/teams/[teamId]/pixels` | A key | 401 | 401 | pass |
| 496 | F2 cross-tenant read | B key reads A | `GET /api/teams/[teamId]/pixels` | B key | 401 | 401 | pass |
| 497 | F1 own data | A key reads A | `GET /api/boards/[boardId]` | A key | 200 | 200 | pass |
| 498 | F1 own data | B key reads B | `GET /api/boards/[boardId]` | B key | 200 | 200 | pass |
| 499 | F2 cross-tenant read | A key reads B | `GET /api/boards/[boardId]` | A key | 401 | 401 | pass |
| 500 | F2 cross-tenant read | B key reads A | `GET /api/boards/[boardId]` | B key | 401 | 401 | pass |
| 501 | F1 own data | A key reads A | `GET /api/boards/[boardId]/shares` | A key | 200 | 200 | pass |
| 502 | F1 own data | B key reads B | `GET /api/boards/[boardId]/shares` | B key | 200 | 200 | pass |
| 503 | F2 cross-tenant read | A key reads B | `GET /api/boards/[boardId]/shares` | A key | 401 | 401 | pass |
| 504 | F2 cross-tenant read | B key reads A | `GET /api/boards/[boardId]/shares` | B key | 401 | 401 | pass |
| 505 | F3 lists | A key lists | `GET /api/websites` | A key | only A | only A | pass |
| 506 | F3 lists | B key lists | `GET /api/websites` | B key | only B | only B | pass |
| 507 | F3 lists | A key lists | `GET /api/me/websites` | A key | only A | only A | pass |
| 508 | F3 lists | B key lists | `GET /api/me/websites` | B key | only B | only B | pass |
| 509 | F3 lists | A key lists | `GET /api/me/teams` | A key | only A | only A | pass |
| 510 | F3 lists | B key lists | `GET /api/me/teams` | B key | only B | only B | pass |
| 511 | F3 lists | A key lists | `GET /api/teams` | A key | only A | only A | pass |
| 512 | F3 lists | B key lists | `GET /api/teams` | B key | only B | only B | pass |
| 513 | F3 lists | A key lists | `GET /api/boards` | A key | only A | only A | pass |
| 514 | F3 lists | B key lists | `GET /api/boards` | B key | only B | only B | pass |
| 515 | F3 lists | A key lists | `GET /api/links` | A key | only A | only A | pass |
| 516 | F3 lists | B key lists | `GET /api/links` | B key | only B | only B | pass |
| 517 | F3 lists | A key lists | `GET /api/pixels` | A key | only A | only A | pass |
| 518 | F3 lists | B key lists | `GET /api/pixels` | B key | only B | only B | pass |
| 519 | F3 lists | A key lists | `GET /api/websites/charts` | A key | only A | only A | pass |
| 520 | F3 lists | B key lists | `GET /api/websites/charts` | B key | only B | only B | pass |
| 521 | F4 closed to every key | A key, own ids | `GET /api/admin/teams` | A key | 401 | 401 | pass |
| 522 | F4 closed to every key | B key, own ids | `GET /api/admin/teams` | B key | 401 | 401 | pass |
| 523 | F4 closed to every key | A key, own ids | `GET /api/admin/users` | A key | 401 | 401 | pass |
| 524 | F4 closed to every key | B key, own ids | `GET /api/admin/users` | B key | 401 | 401 | pass |
| 525 | F4 closed to every key | A key, own ids | `GET /api/admin/websites` | A key | 401 | 401 | pass |
| 526 | F4 closed to every key | B key, own ids | `GET /api/admin/websites` | B key | 401 | 401 | pass |
| 527 | F4 closed to every key | A key, own ids | `GET /api/admin/users/[userId]/2fa` | A key | 401 | 401 | pass |
| 528 | F4 closed to every key | B key, own ids | `GET /api/admin/users/[userId]/2fa` | B key | 401 | 401 | pass |
| 529 | F4 closed to every key | A key, own ids | `GET /api/users/[userId]` | A key | 401 | 401 | pass |
| 530 | F4 closed to every key | B key, own ids | `GET /api/users/[userId]` | B key | 401 | 401 | pass |
| 531 | F4 closed to every key | A key, own ids | `GET /api/users/[userId]/teams` | A key | 401 | 401 | pass |
| 532 | F4 closed to every key | B key, own ids | `GET /api/users/[userId]/teams` | B key | 401 | 401 | pass |
| 533 | F4 closed to every key | A key, own ids | `GET /api/users/[userId]/websites` | A key | 401 | 401 | pass |
| 534 | F4 closed to every key | B key, own ids | `GET /api/users/[userId]/websites` | B key | 401 | 401 | pass |
| 535 | F4 closed to every key | A key, own ids | `GET /api/teams/[teamId]/users/[userId]` | A key | 401 | 401 | pass |
| 536 | F4 closed to every key | B key, own ids | `GET /api/teams/[teamId]/users/[userId]` | B key | 401 | 401 | pass |
| 537 | F4 closed to every key | A key, own ids | `GET /api/me/api-keys` | A key | 401 | 401 | pass |
| 538 | F4 closed to every key | B key, own ids | `GET /api/me/api-keys` | B key | 401 | 401 | pass |
| 539 | F4 closed to every key | A key, own ids | `GET /api/2fa/status` | A key | 401 | 401 | pass |
| 540 | F4 closed to every key | B key, own ids | `GET /api/2fa/status` | B key | 401 | 401 | pass |
| 541 | F4 closed to every key | A key, own ids | `GET /api/dashboard` | A key | 401 | 401 | pass |
| 542 | F4 closed to every key | B key, own ids | `GET /api/dashboard` | B key | 401 | 401 | pass |
| 543 | F5 public by design | recorder settings of B, no credential | `GET /api/websites/:id/recorder` | nobody | 200 {"enabled":false} | 200 {"enabled":false} | pass |
| 544 | F6 inventory | every GET route in the source is probed or listed with a reason | `umami/src/app/api` | source | none unaccounted | none unaccounted | pass |
| 545 | F6 inventory | every route named by this check exists in the source | `umami/src/app/api` | source | none stale | none stale | pass |
| 546 | B slugs | slug "Tenant-Mixed": first run | `worker.provision` | worker | completed | completed | pass |
| 547 | B slugs | slug "Tenant-Mixed": team name, username and website name as stored (database, read-only) | `team, user, website` | read-only SQL | tenant-mixed|svc-tenant-mixed|tenant-mixed | tenant-mixed|svc-tenant-mixed|tenant-mixed | pass |
| 548 | B slugs | slug "Tenant-Mixed": second run, key given | `worker.provision` | worker | completed | completed | pass |
| 549 | B slugs | slug "Tenant-Mixed": second run found the same tenant | `worker.provision` | worker | same ids, key kept | same ids, key kept | pass |
| 550 | B slugs | slug "Tenant-Mixed": third run, slug written in upper case | `worker.provision` | worker | completed | completed | pass |
| 551 | B slugs | slug "Tenant-Mixed": upper case is the same tenant | `worker.provision` | worker | same ids, key kept | same ids, key kept | pass |
| 552 | B slugs | slug "Tenant-Mixed": one of everything (database, read-only) | `all tenant tables` | read-only SQL | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | pass |
| 553 | B slugs | slug "Tenant-Mixed": the key reads its website | `GET /api/websites/9c5b23ab-51dd-4e6f-92c8-b7310e101713/stats` | its key | 200 | 200 | pass |
| 554 | C slugs | slug "Tenant-Mixed": removal, key given | `worker.remove` | worker | completed | completed | pass |
| 555 | C slugs | slug "Tenant-Mixed": nothing left (database, read-only) | `all tenant tables` | read-only SQL | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 | pass |
| 556 | C slugs | slug "Tenant-Mixed": the key is refused | `GET /api/me` | its key | 401 | 401 | pass |
| 557 | C slugs | slug "Tenant-Mixed": removal again, nothing to do | `worker.remove` | worker | completed | completed | pass |
| 558 | B slugs | slug "  Padded-Slug  ": first run | `worker.provision` | worker | completed | completed | pass |
| 559 | B slugs | slug "  Padded-Slug  ": team name, username and website name as stored (database, read-only) | `team, user, website` | read-only SQL | padded-slug|svc-padded-slug|padded-slug | padded-slug|svc-padded-slug|padded-slug | pass |
| 560 | B slugs | slug "  Padded-Slug  ": second run, key given | `worker.provision` | worker | completed | completed | pass |
| 561 | B slugs | slug "  Padded-Slug  ": second run found the same tenant | `worker.provision` | worker | same ids, key kept | same ids, key kept | pass |
| 562 | B slugs | slug "  Padded-Slug  ": third run, slug written in upper case | `worker.provision` | worker | completed | completed | pass |
| 563 | B slugs | slug "  Padded-Slug  ": upper case is the same tenant | `worker.provision` | worker | same ids, key kept | same ids, key kept | pass |
| 564 | B slugs | slug "  Padded-Slug  ": one of everything (database, read-only) | `all tenant tables` | read-only SQL | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | pass |
| 565 | B slugs | slug "  Padded-Slug  ": the key reads its website | `GET /api/websites/241f00a0-7396-4c75-9730-a6f62bd72d3f/stats` | its key | 200 | 200 | pass |
| 566 | C slugs | slug "  Padded-Slug  ": removal, key given | `worker.remove` | worker | completed | completed | pass |
| 567 | C slugs | slug "  Padded-Slug  ": nothing left (database, read-only) | `all tenant tables` | read-only SQL | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 | pass |
| 568 | C slugs | slug "  Padded-Slug  ": the key is refused | `GET /api/me` | its key | 401 | 401 | pass |
| 569 | C slugs | slug "  Padded-Slug  ": removal again, nothing to do | `worker.remove` | worker | completed | completed | pass |
| 570 | B slugs | slug "ténant-É": first run | `worker.provision` | worker | completed | completed | pass |
| 571 | B slugs | slug "ténant-É": team name, username and website name as stored (database, read-only) | `team, user, website` | read-only SQL | ténant-é|svc-ténant-é|ténant-é | ténant-é|svc-ténant-é|ténant-é | pass |
| 572 | B slugs | slug "ténant-É": second run, key given | `worker.provision` | worker | completed | completed | pass |
| 573 | B slugs | slug "ténant-É": second run found the same tenant | `worker.provision` | worker | same ids, key kept | same ids, key kept | pass |
| 574 | B slugs | slug "ténant-É": third run, slug written in upper case | `worker.provision` | worker | completed | completed | pass |
| 575 | B slugs | slug "ténant-É": upper case is the same tenant | `worker.provision` | worker | same ids, key kept | same ids, key kept | pass |
| 576 | B slugs | slug "ténant-É": one of everything (database, read-only) | `all tenant tables` | read-only SQL | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | pass |
| 577 | B slugs | slug "ténant-É": the key reads its website | `GET /api/websites/ba1b9682-e018-4988-ab79-ef546c22267e/stats` | its key | 200 | 200 | pass |
| 578 | C slugs | slug "ténant-É": removal, key given | `worker.remove` | worker | completed | completed | pass |
| 579 | C slugs | slug "ténant-É": nothing left (database, read-only) | `all tenant tables` | read-only SQL | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 | pass |
| 580 | C slugs | slug "ténant-É": the key is refused | `GET /api/me` | its key | 401 | 401 | pass |
| 581 | C slugs | slug "ténant-É": removal again, nothing to do | `worker.remove` | worker | completed | completed | pass |
| 582 | B slugs | slug "İstanbul": first run | `worker.provision` | worker | completed | completed | pass |
| 583 | B slugs | slug "İstanbul": team name, username and website name as stored (database, read-only) | `team, user, website` | read-only SQL | i̇stanbul|svc-i̇stanbul|i̇stanbul | i̇stanbul|svc-i̇stanbul|i̇stanbul | pass |
| 584 | B slugs | slug "İstanbul": second run, key given | `worker.provision` | worker | completed | completed | pass |
| 585 | B slugs | slug "İstanbul": second run found the same tenant | `worker.provision` | worker | same ids, key kept | same ids, key kept | pass |
| 586 | B slugs | slug "İstanbul": third run, slug written in upper case | `worker.provision` | worker | completed | completed | pass |
| 587 | B slugs | slug "İstanbul": upper case is the same tenant | `worker.provision` | worker | same ids, key kept | same ids, key kept | pass |
| 588 | B slugs | slug "İstanbul": one of everything (database, read-only) | `all tenant tables` | read-only SQL | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | pass |
| 589 | B slugs | slug "İstanbul": the key reads its website | `GET /api/websites/f56901c7-9606-48bf-a72c-6843f9129d4d/stats` | its key | 200 | 200 | pass |
| 590 | C slugs | slug "İstanbul": removal, key given | `worker.remove` | worker | completed | completed | pass |
| 591 | C slugs | slug "İstanbul": nothing left (database, read-only) | `all tenant tables` | read-only SQL | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 | pass |
| 592 | C slugs | slug "İstanbul": the key is refused | `GET /api/me` | its key | 401 | 401 | pass |
| 593 | C slugs | slug "İstanbul": removal again, nothing to do | `worker.remove` | worker | completed | completed | pass |
| 594 | C read-back | a tenant is provisioned | `worker.provision` | worker | completed | completed | pass |
| 595 | C read-back | its user is renamed by hand; removal must not report success | `worker.remove` | worker | error: removal incomplete: the team still has a member that is not its owner | error: removal incomplete: the team still has a member that is not its owner | pass |
| 596 | C read-back | and it is right not to: the key is still accepted | `GET /api/me` | its key | 200 | 200 | pass |
| 597 | C read-back | once that user is deleted by id, removal completes | `worker.remove` | worker | completed | completed | pass |
| 598 | C read-back | nothing left (database, read-only) | `all tenant tables` | read-only SQL | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 | pass |
| 599 | C read-back | the key is refused | `GET /api/me` | its key | 401 | 401 | pass |
| 600 | C removal | other order: admin deletes the team first | `DELETE /api/teams/e701d1d2-a96a-4a11-b369-ba6584336ab1` | admin | 200 | 200 | pass |
| 601 | C removal | other order: the key still authenticates | `GET /api/me` | its key | 200 | 200 | pass |
| 602 | C removal | other order: the worker finishes the removal | `worker.remove` | worker | completed | completed | pass |
| 603 | C removal | other order: the key is refused once the user is gone | `GET /api/me` | its key | 401 | 401 | pass |
| 604 | C removal | B before removal (database, read-only) | `all tenant tables` | read-only SQL | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1 | pass |
| 605 | C removal | B data before removal (database, read-only) | `website and user rows` | read-only SQL | events=3 sessions=1 event_data=1 reports=2 segments=1 annotations=1 memberships=2 boards=1 shares=0 | events=3 sessions=1 event_data=1 reports=2 segments=1 annotations=1 memberships=2 boards=1 shares=0 | pass |
| 606 | C removal | B: removal stopped after its first step | `worker.remove` | worker | interrupted | interrupted | pass |
| 607 | C removal | B: after that one step the key is refused | `GET /api/me` | B key | 401 | 401 | pass |
| 608 | C removal | B: and reads nothing | `GET /api/websites/0947bafe-cf7e-4a39-a23c-6f7525e23443/stats` | B key | 401 | 401 | pass |
| 609 | C removal | B: what is left after that one step (database, read-only) | `all tenant tables` | read-only SQL | teams=1 users=0 roles=team-owner global=none websites=1 boards=1 keys=0 id-reserved=0 | teams=1 users=0 roles=team-owner global=none websites=1 boards=1 keys=0 id-reserved=0 | pass |
| 610 | C removal | B: removal run again, given the key the console holds | `worker.remove` | worker | completed | completed | pass |
| 611 | C removal | B: nothing left (database, read-only) | `all tenant tables` | read-only SQL | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 | pass |
| 612 | C removal | B: no data left (database, read-only) | `website and user rows` | read-only SQL | events=0 sessions=0 event_data=0 reports=0 segments=0 annotations=0 memberships=0 boards=0 shares=0 | events=0 sessions=0 event_data=0 reports=0 segments=0 annotations=0 memberships=0 boards=0 shares=0 | pass |
| 613 | C removal | B: removal run a third time, nothing to do | `worker.remove` | worker | completed | completed | pass |
| 614 | C removal | A: removal stopped after its last step | `worker.remove` | worker | interrupted | interrupted | pass |
| 615 | C removal | A: removal run again | `worker.remove` | worker | completed | completed | pass |
| 616 | C removal | A: nothing left (database, read-only) | `all tenant tables` | read-only SQL | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 | pass |
| 617 | C removal | A: the key is refused | `GET /api/me` | A key | 401 | 401 | pass |
| 618 | C removal | the 10 other completed tenants: removed, key refused | `worker.remove` | worker | 0 of 10 left | 0 of 10 left | pass |
| 619 | C removal | half-made tenant, provisioning stopped after "team" | `worker.provision` | worker | interrupted | interrupted | pass |
| 620 | C removal | half-made after "team": removal | `worker.remove` | worker | completed | completed | pass |
| 621 | C removal | half-made after "team": nothing left, no key accepted | `all tenant tables, /api/me` | read-only SQL, its keys | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 keys accepted 0/0 | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 keys accepted 0/0 | pass |
| 622 | C removal | half-made tenant, provisioning stopped after "join-code" | `worker.provision` | worker | interrupted | interrupted | pass |
| 623 | C removal | half-made after "join-code": removal | `worker.remove` | worker | completed | completed | pass |
| 624 | C removal | half-made after "join-code": nothing left, no key accepted | `all tenant tables, /api/me` | read-only SQL, its keys | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 keys accepted 0/0 | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 keys accepted 0/0 | pass |
| 625 | C removal | half-made tenant, provisioning stopped after "reserve-id" | `worker.provision` | worker | interrupted | interrupted | pass |
| 626 | C removal | half-made after "reserve-id": removal | `worker.remove` | worker | completed | completed | pass |
| 627 | C removal | half-made after "reserve-id": nothing left, no key accepted | `all tenant tables, /api/me` | read-only SQL, its keys | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 keys accepted 0/0 | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 keys accepted 0/0 | pass |
| 628 | C removal | half-made tenant, provisioning stopped after "user" | `worker.provision` | worker | interrupted | interrupted | pass |
| 629 | C removal | half-made after "user": removal | `worker.remove` | worker | completed | completed | pass |
| 630 | C removal | half-made after "user": nothing left, no key accepted | `all tenant tables, /api/me` | read-only SQL, its keys | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 keys accepted 0/0 | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 keys accepted 0/0 | pass |
| 631 | C removal | half-made tenant, provisioning stopped after "membership" | `worker.provision` | worker | interrupted | interrupted | pass |
| 632 | C removal | half-made after "membership": removal | `worker.remove` | worker | completed | completed | pass |
| 633 | C removal | half-made after "membership": nothing left, no key accepted | `all tenant tables, /api/me` | read-only SQL, its keys | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 keys accepted 0/0 | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 keys accepted 0/0 | pass |
| 634 | C removal | half-made tenant, provisioning stopped after "website" | `worker.provision` | worker | interrupted | interrupted | pass |
| 635 | C removal | half-made after "website": removal | `worker.remove` | worker | completed | completed | pass |
| 636 | C removal | half-made after "website": nothing left, no key accepted | `all tenant tables, /api/me` | read-only SQL, its keys | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 keys accepted 0/0 | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 keys accepted 0/0 | pass |
| 637 | C removal | half-made tenant, provisioning stopped after "password" | `worker.provision` | worker | interrupted | interrupted | pass |
| 638 | C removal | half-made after "password": removal | `worker.remove` | worker | completed | completed | pass |
| 639 | C removal | half-made after "password": nothing left, no key accepted | `all tenant tables, /api/me` | read-only SQL, its keys | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 keys accepted 0/0 | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 keys accepted 0/0 | pass |
| 640 | C removal | half-made tenant, provisioning stopped after "sign-in" | `worker.provision` | worker | interrupted | interrupted | pass |
| 641 | C removal | half-made after "sign-in": removal | `worker.remove` | worker | completed | completed | pass |
| 642 | C removal | half-made after "sign-in": nothing left, no key accepted | `all tenant tables, /api/me` | read-only SQL, its keys | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 keys accepted 0/0 | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 keys accepted 0/0 | pass |
| 643 | C removal | half-made tenant, provisioning stopped after "key" | `worker.provision` | worker | interrupted | interrupted | pass |
| 644 | C removal | half-made after "key": removal | `worker.remove` | worker | completed | completed | pass |
| 645 | C removal | half-made after "key": nothing left, no key accepted | `all tenant tables, /api/me` | read-only SQL, its keys | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 keys accepted 0/1 | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 keys accepted 0/1 | pass |
| 646 | C removal | half-made tenant, provisioning stopped after "prune-keys" | `worker.provision` | worker | interrupted | interrupted | pass |
| 647 | C removal | half-made after "prune-keys": removal | `worker.remove` | worker | completed | completed | pass |
| 648 | C removal | half-made after "prune-keys": nothing left, no key accepted | `all tenant tables, /api/me` | read-only SQL, its keys | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 keys accepted 0/1 | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 keys accepted 0/1 | pass |
| 649 | C removal | half-made tenant, provisioning stopped after "discard-password" | `worker.provision` | worker | interrupted | interrupted | pass |
| 650 | C removal | half-made after "discard-password": removal | `worker.remove` | worker | completed | completed | pass |
| 651 | C removal | half-made after "discard-password": nothing left, no key accepted | `all tenant tables, /api/me` | read-only SQL, its keys | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 keys accepted 0/1 | teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0 keys accepted 0/1 | pass |
| 652 | C removal | whole database after every tenant and control is removed (read-only) | `all tables` | read-only SQL | users=admin teams=0 memberships=0 websites=0 events=0 boards=0 shares=0 keys=0 | users=admin teams=0 memberships=0 websites=0 events=0 boards=0 shares=0 keys=0 | pass |
| 653 | C removal | the connection this script uses refuses writes | `CREATE TABLE` | read-only SQL | refused | refused | pass |

GET routes in Umami's source: 119. Probed: 106 (61 website routes, 11 id routes with a stored object, 6 id routes guard only, 9 other routes with a tenant id, 8 lists, 11 closed to every key). Not probed, with reason: 13.
  not probed: heartbeat (public, returns no data)
  not probed: scripts/telemetry (public, returns a script)
  not probed: auth/subscription (returns the caller's own plan, takes no id)
  not probed: me (returns the caller's own identity, takes no id; used in group A)
  not probed: websites/[websiteId]/recorder (public by design, settings only; probed without a credential)
  not probed: share/[slug] (public by design; no share exists for a provisioned tenant (group E))
  not probed: share/id/[shareId] (no share exists for a provisioned tenant (group E))
  not probed: links/[linkId] (tenants have no links; a view-only key cannot create one (group E))
  not probed: links/[linkId]/shares (tenants have no links)
  not probed: links/charts (tenants have no links)
  not probed: pixels/[pixelId] (tenants have no pixels; a view-only key cannot create one (group E))
  not probed: pixels/[pixelId]/shares (tenants have no pixels)
  not probed: pixels/charts (tenants have no pixels)

653 rows, 0 not as expected
A: Yes. Team, user, membership, website and key through the API; the password is never stored.
B: Yes. A second run changes nothing; a run stopped after any of 11 steps is completed by the next.
C: Yes. User first, then team; the key is refused after the first call; nothing is left.
D: Yes, with one stated condition. The join code cannot be switched off, only replaced by a value nobody keeps.
E: Yes, with one stated condition. The service user's id must be held by a team board before the user exists.
F: Yes. No cross-tenant read on any probed route; every GET route is accounted for.
VERDICT: YES for the reworded claim, with the two conditions stated under D and E.
