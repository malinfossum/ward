using Microsoft.EntityFrameworkCore;

namespace Fixture.Data;

public class Note
{
    public int Id { get; set; }

    public string Title { get; set; } = "";
}

public class FixtureContext : DbContext
{
    public DbSet<Note> Notes => Set<Note>();

    protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
        => optionsBuilder.UseSqlite("Data Source=fixture.db");

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        // FIXTURE_PENDING=1 adds a column the committed snapshot does not have,
        // so the pending-migrations check has a case it must reject.
        if (Environment.GetEnvironmentVariable("FIXTURE_PENDING") == "1")
        {
            modelBuilder.Entity<Note>().Property<string>("Extra");
        }
    }
}
