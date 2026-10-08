using Fixture.Data;

namespace Fixture.Tests;

public class UnitTest1
{
    [Fact]
    public void TheContextExposesNotes()
    {
        using var context = new FixtureContext();
        Assert.NotNull(context.Notes);
    }
}
