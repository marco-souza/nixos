package job

import (
	"os"
	"regexp"
	"strings"
)

var (
	stopwords  = map[string]bool{"a": true, "an": true, "the": true, "to": true, "of": true, "for": true, "and": true, "in": true, "on": true, "with": true, "into": true, "from": true, "by": true}
	nonAlnum   = regexp.MustCompile(`[^a-z0-9]+`)
	ticketRE   = regexp.MustCompile(`\b[A-Z][A-Z0-9]+-\d+\b`)
	ticketPart = regexp.MustCompile(`^[a-z][a-z0-9]*-\d+$`)

	// accents folds Latin letters with diacritics to their base letter. The
	// standard library has no Unicode normalization, and the module has no
	// golang.org/x/text.
	accents = strings.NewReplacer(
		"à", "a", "á", "a", "â", "a", "ã", "a", "ä", "a", "å", "a", "ā", "a",
		"ç", "c", "ć", "c", "č", "c",
		"è", "e", "é", "e", "ê", "e", "ë", "e", "ē", "e", "ę", "e",
		"ì", "i", "í", "i", "î", "i", "ï", "i", "ī", "i",
		"ñ", "n", "ń", "n",
		"ò", "o", "ó", "o", "ô", "o", "õ", "o", "ö", "o", "ø", "o", "ō", "o",
		"ś", "s", "š", "s",
		"ù", "u", "ú", "u", "û", "u", "ü", "u", "ū", "u",
		"ý", "y", "ÿ", "y",
		"ź", "z", "ž", "z", "ż", "z",
	)
)

// Slugify is the fallback branch slug of a feature: up to four words.
func Slugify(feature string) string {
	var words []string
	for w := range strings.SplitSeq(nonAlnum.ReplaceAllString(accents.Replace(strings.ToLower(feature)), " "), " ") {
		if w != "" && !stopwords[w] {
			words = append(words, w)
		}
	}
	if len(words) > 4 {
		words = words[:4]
	}
	if len(words) == 0 {
		return "job"
	}
	return strings.Join(words, "-")
}

// TicketOf is the first ticket key text mentions, alone or in a URL: "ABC-123".
func TicketOf(text string) string { return ticketRE.FindString(text) }

// CaseBranch lowercases a branch, except a middle part shaped like a ticket
// key, which is uppercase: "fix/ABC-2/raise-timeout".
func CaseBranch(branch string) string {
	parts := strings.Split(strings.ToLower(branch), "/")
	for i, p := range parts {
		if i > 0 && i < len(parts)-1 && ticketPart.MatchString(p) {
			parts[i] = strings.ToUpper(p)
		}
	}
	return strings.Join(parts, "/")
}

// IDFor is the branch without its type, made safe for folder names:
// "fix/ABC-123/raise-timeout" becomes "abc-123-raise-timeout".
func IDFor(branch string) string {
	parts := strings.Split(branch, "/")
	if len(parts) > 1 {
		parts = parts[1:]
	}
	id := strings.Trim(nonAlnum.ReplaceAllString(strings.ToLower(strings.Join(parts, "-")), "-"), "-")
	if id == "" {
		return "job"
	}
	return id
}

// TakenIDs are the ids a new job can't use: the local job folders, and the
// names of the folders that share their parent.
func TakenIDs(repo string) map[string]bool {
	taken := map[string]bool{"jobs": true, "archive": true}
	entries, err := os.ReadDir(NewPaths(repo, "").JobsDir)
	if err != nil {
		return taken
	}
	for _, e := range entries {
		taken[e.Name()] = true
	}
	return taken
}
