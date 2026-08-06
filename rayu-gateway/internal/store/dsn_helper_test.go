package store

import (
	"fmt"
	"net/url"
	"strings"
)

// mysqlDSNForTest converts a prisma-style URL into a go-sql-driver DSN. It
// duplicates internal/config.MySQLDSN deliberately: the store must not import
// config (config depends on nothing, and a store→config edge would invert the
// dependency direction), and this exists only for the live-MySQL tests.
func mysqlDSNForTest(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	if u.Scheme != "mysql" {
		return "", fmt.Errorf("unsupported scheme %q (want mysql)", u.Scheme)
	}
	pass, _ := u.User.Password()
	cred := u.User.Username()
	if pass != "" {
		cred += ":" + pass
	}
	host := u.Host
	if host == "" {
		host = "127.0.0.1:3306"
	}
	q := u.Query()
	q.Set("parseTime", "true")
	q.Set("loc", "UTC")
	return fmt.Sprintf("%s@tcp(%s)/%s?%s", cred, host, strings.TrimPrefix(u.Path, "/"), q.Encode()), nil
}
