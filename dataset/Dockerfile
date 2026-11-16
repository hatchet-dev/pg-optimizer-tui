# The race database, baked into the image so every sandbox starts with it. PGDATA sits outside the
# sandbox workspace: the sandbox snapshots only the workspace, so calls stay fast and forks stay small.
# Build: docker build -t pgrace-seed:shop dataset
FROM postgres:17
ENV PGDATA=/var/lib/postgresql/race
COPY seed.sql /seed.sql
RUN mkdir -p $PGDATA && chown postgres $PGDATA \
 && gosu postgres initdb -A trust -D $PGDATA >/dev/null \
 && gosu postgres pg_ctl -D $PGDATA -w -o "-c listen_addresses='' -k /tmp -c max_wal_size=64MB" start \
 && gosu postgres psql -h /tmp -U postgres -X -q -v ON_ERROR_STOP=1 -f /seed.sql \
 && gosu postgres pg_ctl -D $PGDATA -m fast -w stop \
 && du -sh $PGDATA
