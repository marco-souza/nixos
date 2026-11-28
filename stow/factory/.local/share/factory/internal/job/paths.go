package job

import (
	"fmt"
	"path/filepath"
)

// Paths are the files and folders of one job. Id "" gives the shared folders.
type Paths struct {
	FactoryDir  string
	JobsDir     string
	JobDir      string
	JobFile     string
	ActivityLog string
	LogsDir     string
	DoneDir     string
	RunDir      string
	// GrillDir holds the grill's transcript and pending question.
	GrillDir string
	ProofDir string
	PRFile   string
	// ReportFile is a report job's deliverable.
	ReportFile string
	// AccessFile holds the access check's results.
	AccessFile string
	// DocsDir holds the job's docs. They never go on the branch.
	DocsDir  string
	Worktree string
}

// NewPaths returns the paths of job id in repo.
func NewPaths(repo, id string) Paths {
	factoryDir := filepath.Join(repo, ".factory")
	jobsDir := filepath.Join(factoryDir, "jobs")
	jobDir := filepath.Join(jobsDir, id)
	return Paths{
		FactoryDir:  factoryDir,
		JobsDir:     jobsDir,
		JobDir:      jobDir,
		JobFile:     filepath.Join(jobDir, "job.json"),
		ActivityLog: filepath.Join(jobDir, "activity.log"),
		LogsDir:     filepath.Join(jobDir, "logs"),
		DoneDir:     filepath.Join(jobDir, "done"),
		RunDir:      filepath.Join(jobDir, "run"),
		GrillDir:    filepath.Join(jobDir, "grill"),
		ProofDir:    filepath.Join(jobDir, "proof"),
		PRFile:      filepath.Join(jobDir, "pr.md"),
		ReportFile:  filepath.Join(jobDir, "report.md"),
		AccessFile:  filepath.Join(jobDir, "access.md"),
		DocsDir:     filepath.Join(jobDir, "docs"),
		Worktree:    filepath.Join(factoryDir, id),
	}
}

// TripDir is the folder of trip t's handoff files.
func (p Paths) TripDir(t int) string { return filepath.Join(p.JobDir, fmt.Sprintf("trip-%d", t)) }

// DiscoveryReview is the file of discovery review n.
func (p Paths) DiscoveryReview(n int) string {
	return filepath.Join(p.JobDir, fmt.Sprintf("discovery-review-%d.md", n))
}

// Feedback is the file of feedback k.
func (p Paths) Feedback(k int) string {
	return filepath.Join(p.JobDir, fmt.Sprintf("feedback-%d.md", k))
}

// Decision is the file of decision k.
func (p Paths) Decision(k int) string {
	return filepath.Join(p.JobDir, fmt.Sprintf("decision-%d.md", k))
}

// Doc is the job's doc of the given kind, such as "requirements".
func (p Paths) Doc(kind string) string { return filepath.Join(p.DocsDir, kind+".md") }
